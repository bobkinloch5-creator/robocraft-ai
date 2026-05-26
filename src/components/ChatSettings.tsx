import { useEffect, useRef, useState } from "react";
import { Settings, Brain, Zap, ClipboardList, Trash2, X, Cpu } from "lucide-react";

type Props = {
  thinking: boolean;
  onToggleThinking: (v: boolean) => void;
  autoExecute: boolean;
  onToggleAutoExecute: (v: boolean) => void;
  planMode: boolean;
  onTogglePlanMode: (v: boolean) => void;
  onClearChat: () => void;
  canClearChat: boolean;
  studioConnected: boolean;
};

function Row({
  icon,
  title,
  desc,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-left hover:bg-surface-elevated transition"
    >
      <div className="mt-0.5 text-primary">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
      <div
        className={`mt-0.5 h-4 w-7 rounded-full transition relative ${checked ? "bg-primary" : "bg-muted"}`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-background transition-all ${checked ? "left-3.5" : "left-0.5"}`}
        />
      </div>
    </button>
  );
}

export function ChatSettings(props: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Chat settings"
        className={`h-7 w-7 grid place-items-center rounded-md transition ${open ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-surface-elevated"}`}
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-72 rounded-xl border border-border bg-surface shadow-2xl p-3 space-y-2">
          <div className="flex items-center justify-between pb-1">
            <div className="text-xs font-semibold text-foreground">Chat settings</div>
            <button
              onClick={() => setOpen(false)}
              className="h-6 w-6 grid place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-elevated"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <Row
            icon={<Brain className="h-3.5 w-3.5" />}
            title="Thinking mode"
            desc="Spend more compute for deeper reasoning."
            checked={props.thinking}
            onChange={props.onToggleThinking}
          />
          <Row
            icon={<ClipboardList className="h-3.5 w-3.5" />}
            title="Plan first"
            desc="Draft a plan before writing files."
            checked={props.planMode}
            onChange={props.onTogglePlanMode}
          />
          <Row
            icon={<Zap className="h-3.5 w-3.5" />}
            title="Auto-build safe ops"
            desc="Execute non-destructive actions in Studio automatically."
            checked={props.autoExecute}
            onChange={props.onToggleAutoExecute}
          />

          <div className="rounded-lg border border-border bg-background/40 px-3 py-2 flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5 text-primary" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold">Model</div>
              <div className="text-[10px] text-muted-foreground">
                Groq · tools enabled · {props.studioConnected ? "Studio live" : "Studio waiting"}
              </div>
            </div>
          </div>

          <button
            onClick={() => {
              props.onClearChat();
              setOpen(false);
            }}
            disabled={!props.canClearChat}
            className="w-full flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-semibold text-destructive hover:bg-destructive/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear chat history
          </button>
        </div>
      )}
    </div>
  );
}
