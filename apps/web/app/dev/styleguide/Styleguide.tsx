"use client";
import { useState } from "react";
import { Navigation, Footer } from "../../../components/Shell";
import {
  Button,
  IconButton,
  Card,
  Field,
  RadioCard,
  Meter,
  Stat,
  Skeleton,
  Badge,
  Dialog,
  Checkbox,
  Switch,
  Popover,
  Textarea,
  Select,
} from "../../../components/ui/Primitives";
import { CockpitPanels } from "../../../components/CockpitPanels";
import { CodeEditor } from "../../../components/CodeEditor";
import { Notepad } from "../../../components/Notepad";
import { SpeechCaption } from "../../../components/SpeechCaption";
import { VoicePreflight } from "../../../components/VoicePreflight";
import cockpit from "../../../components/Cockpit.module.css";
import s from "../../Screens.module.css";
export function Styleguide() {
  const [dialog, setDialog] = useState(false);
  const [preflight, setPreflight] = useState(false);
  const [code, setCode] = useState("# Synthetic workspace preview\n\n");
  const [notes, setNotes] = useState("");
  return (
    <>
      <section className={s.page}>
        <Navigation />
        <h1>Interface reference</h1>
        <p>
          Development only. Synthetic fixtures; no interview connection or
          microphone opens automatically.
        </p>
        <Card>
          <h2>Controls</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {(["primary", "secondary", "ghost", "danger"] as const).map(
              (variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ),
            )}
            <Button disabled>Disabled</Button>
            <Button loading>Working</Button>
            <IconButton icon="settings" label="Settings" />
          </div>
          <Field label="Example input" hint="Helper text">
            {(props) => <input {...props} placeholder="Your answer" />}
          </Field>
          <Field label="Invalid input" error="Provide a value">
            {(props) => <input {...props} />}
          </Field>
          <fieldset>
            <legend>Example choice</legend>
            <RadioCard
              name="example"
              title="First choice"
              description="Default selection"
              defaultChecked
            />
            <RadioCard
              name="example"
              title="Second choice"
              description="Another option"
            />
          </fieldset>
          <Checkbox label="Example consent" />
          <Switch label="Read captions" />
          <Field label="Example notes">
            {(props) => <Textarea {...props} />}
          </Field>
          <Field label="Example select">
            {(props) => (
              <Select {...props}>
                <option>First choice</option>
                <option>Second choice</option>
              </Select>
            )}
          </Field>
          <Popover label="Example popover">
            <p>A native disclosure panel.</p>
          </Popover>
          <Badge>Connected</Badge>
          <Meter label="Synthetic microphone level" value={35} />
          <Stat label="Remaining" value="38:24" />
          <Skeleton height={40} />
          <Button onClick={() => setDialog(true)}>
            Open example dialog
          </Button>{" "}
          <Button onClick={() => setPreflight(true)}>Open voice check</Button>
        </Card>
        <Footer />
      </section>
      <section
        className={cockpit.workspace}
        aria-label="Synthetic cockpit preview"
      >
        <header className="workspace-header">
          <h2>Workspace preview</h2>
          <span>Disconnected fixture · no interview</span>
        </header>
        <CockpitPanels
          onMute={() => {}}
          editor={
            <CodeEditor language="python" value={code} onChange={setCode} />
          }
          notes={<Notepad value={notes} onChange={setNotes} />}
          captions={
            <SpeechCaption
              active={false}
              interim=""
              lines={["Synthetic caption: I am considering two approaches."]}
            />
          }
        />
      </section>
      {dialog && (
        <Dialog title="Example dialog" onClose={() => setDialog(false)}>
          <p>Escape closes this dialog and returns focus to its trigger.</p>
        </Dialog>
      )}
      {preflight && (
        <VoicePreflight
          onCancel={() => setPreflight(false)}
          onContinue={() => setPreflight(false)}
        />
      )}
    </>
  );
}
