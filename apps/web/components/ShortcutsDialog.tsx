"use client";
import { Dialog } from "./ui/Primitives";
import s from "./Shell.module.css";
export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <dl className={s.shortcuts}>
        {[
          ["?", "Open keyboard help"],
          ["t", "Cycle appearance"],
          ["g then h", "Interview history"],
          ["g then s", "Settings"],
          ["Ctrl / Cmd + Enter", "Run the tests in the interview room"],
          ["Ctrl / Cmd + M", "Think quietly: pause the microphone in a voice interview"],
          ["Enter", "Send a message; Shift + Enter adds a line"],
          ["Escape", "Close a dialog or menu"],
        ].map(([key, text]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p>Single-key shortcuts are disabled while you type.</p>
    </Dialog>
  );
}
