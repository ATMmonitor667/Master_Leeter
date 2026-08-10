import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";

/**
 * Semantic snapshot (server half of M2-5).
 *
 * The interviewer must be able to reason about what the candidate has written
 * without the full file ever entering a model context. This produces a compact
 * structural summary — functions, loops, recursion, which containers are in
 * play, which regions changed — that the observer turns into CandidateState.
 *
 * Tree-sitter via WASM rather than the native bindings: the WASM build needs no
 * compiler toolchain in CI, parses fast enough for a debounced path, and is
 * error-tolerant. Candidate code is syntactically broken most of the time it is
 * being written, and a parser that refuses half-typed input would only produce
 * snapshots at moments the candidate is least interesting.
 */

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const wasmPath = require.resolve("tree-sitter-python/tree-sitter-python.wasm");
      const python = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(python);
      return parser;
    })();
  }
  return parserPromise;
}

export interface FunctionSummary {
  name: string;
  params: string[];
  startLine: number;
  endLine: number;
  /** Calls itself, directly. Distinguishes iterative from recursive families. */
  recursive: boolean;
  loopCount: number;
  maxLoopDepth: number;
  hasEarlyReturn: boolean;
}

export interface SemanticSnapshot {
  revision: number;
  parsedAt: string;
  /** True when the file has no ERROR nodes — a cheap proxy for "would compile". */
  syntaxValid: boolean;
  functions: FunctionSummary[];
  /** Container constructors and literals seen: set, dict, list, deque, Counter… */
  dataStructures: string[];
  /** Names called anywhere. Used for recognition signals like `.add` or `sorted`. */
  callsMade: string[];
  totalLines: number;
  nonEmptyLines: number;
  /** Line ranges that differ from the previous revision. */
  changedRegions: Array<{ startLine: number; endLine: number }>;
  /** Fraction of lines that changed. Feeds the LARGE_REWRITE milestone. */
  churn: number;
}

const CONTAINER_NAMES = new Set([
  "set", "dict", "list", "tuple", "frozenset",
  "defaultdict", "Counter", "OrderedDict", "deque", "heapq",
]);

export async function buildSnapshot(
  code: string,
  revision: number,
  previous?: { code: string } | undefined,
): Promise<SemanticSnapshot> {
  const parser = await getParser();
  const tree = parser.parse(code);
  const root = tree?.rootNode;

  if (!root) {
    // Parsing should not fail, but a snapshot is advisory — never let it break
    // a live session.
    return emptySnapshot(revision, code, previous);
  }

  const functions: FunctionSummary[] = [];
  const dataStructures = new Set<string>();
  const callsMade = new Set<string>();

  walk(root, (node) => {
    if (node.type === "function_definition") {
      functions.push(summarizeFunction(node));
    }

    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const name = fn?.text ?? "";
      if (name) {
        callsMade.add(name);
        const base = name.split(".").pop() ?? name;
        if (CONTAINER_NAMES.has(name) || CONTAINER_NAMES.has(base)) dataStructures.add(base);
      }
    }

    // Literals count too: `seen = {}` and `seen = set()` are the same intent.
    if (node.type === "set" || node.type === "set_comprehension") dataStructures.add("set");
    if (node.type === "dictionary" || node.type === "dictionary_comprehension") dataStructures.add("dict");
    if (node.type === "list" || node.type === "list_comprehension") dataStructures.add("list");
  });

  return {
    revision,
    parsedAt: new Date().toISOString(),
    syntaxValid: !root.hasError,
    functions,
    dataStructures: [...dataStructures].sort(),
    callsMade: [...callsMade].sort(),
    ...lineStats(code, previous?.code),
  };
}

function summarizeFunction(node: Node): FunctionSummary {
  const name = node.childForFieldName("name")?.text ?? "<anonymous>";
  const paramsNode = node.childForFieldName("parameters");
  const params: string[] = [];

  if (paramsNode) {
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const child = paramsNode.namedChild(i);
      if (child) params.push(child.text);
    }
  }

  const body = node.childForFieldName("body");
  let loopCount = 0;
  let maxLoopDepth = 0;
  let hasEarlyReturn = false;
  let recursive = false;

  if (body) {
    walkDepth(body, 0, (child, depth) => {
      if (child.type === "for_statement" || child.type === "while_statement") {
        loopCount++;
        maxLoopDepth = Math.max(maxLoopDepth, depth + 1);
      }
      if (child.type === "return_statement" && depth > 0) hasEarlyReturn = true;
      if (child.type === "call" && child.childForFieldName("function")?.text === name) {
        recursive = true;
      }
    });
  }

  return {
    name,
    params,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    recursive,
    loopCount,
    maxLoopDepth,
    hasEarlyReturn,
  };
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, visit);
  }
}

/** Depth counts only nesting constructs, so loop depth means what it looks like. */
function walkDepth(node: Node, depth: number, visit: (n: Node, d: number) => void): void {
  visit(node, depth);
  const nests = node.type === "for_statement" || node.type === "while_statement";
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkDepth(child, nests ? depth + 1 : depth, visit);
  }
}

function lineStats(code: string, previousCode?: string) {
  const lines = code.split("\n");
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0).length;

  if (previousCode === undefined) {
    return {
      totalLines: lines.length,
      nonEmptyLines,
      changedRegions: [],
      churn: 0,
    };
  }

  const prev = previousCode.split("\n");
  const changedRegions: Array<{ startLine: number; endLine: number }> = [];
  let changed = 0;
  let open: number | null = null;

  const max = Math.max(lines.length, prev.length);
  for (let i = 0; i < max; i++) {
    const differs = lines[i] !== prev[i];
    if (differs) {
      changed++;
      if (open === null) open = i;
    } else if (open !== null) {
      changedRegions.push({ startLine: open, endLine: i - 1 });
      open = null;
    }
  }
  if (open !== null) changedRegions.push({ startLine: open, endLine: max - 1 });

  return {
    totalLines: lines.length,
    nonEmptyLines,
    changedRegions,
    churn: max === 0 ? 0 : changed / max,
  };
}

function emptySnapshot(
  revision: number,
  code: string,
  previous?: { code: string } | undefined,
): SemanticSnapshot {
  return {
    revision,
    parsedAt: new Date().toISOString(),
    syntaxValid: false,
    functions: [],
    dataStructures: [],
    callsMade: [],
    ...lineStats(code, previous?.code),
  };
}

/**
 * Matches a snapshot against the scenario's authored recognition signals.
 *
 * Deliberately conservative: it returns a family only when the evidence is
 * unambiguous. A wrong family id is worse than none — it feeds the complexity
 * probe, and probing someone about an approach they are not taking is exactly
 * the kind of visible failure the freshness guard exists to prevent.
 */
export function detectSolutionFamily(snapshot: SemanticSnapshot): string | null {
  const fn = snapshot.functions[0];
  if (!fn) return null;

  const hasHashContainer =
    snapshot.dataStructures.includes("set") ||
    snapshot.dataStructures.includes("dict") ||
    snapshot.dataStructures.includes("Counter") ||
    snapshot.dataStructures.includes("defaultdict");

  const sorts = snapshot.callsMade.some((c) => c === "sorted" || c.endsWith(".sort"));

  if (fn.maxLoopDepth >= 2) return "sf-nested-loop";
  if (sorts) return "sf-sort";

  if (hasHashContainer && fn.loopCount === 1) return "sf-set-single-pass";
  if (hasHashContainer && fn.loopCount >= 2) return "sf-count-then-scan";

  return null;
}
