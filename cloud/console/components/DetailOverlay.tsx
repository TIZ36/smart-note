"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { IconClose } from "./icons";

type DetailContent = {
  title: string;
  sub?: string;
  mono?: boolean;
  body: ReactNode;
};

type DetailCtx = {
  open: (c: DetailContent) => void;
  close: () => void;
};

const Ctx = createContext<DetailCtx | null>(null);

export function useDetail() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDetail outside DetailProvider");
  return v;
}

export function DetailProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<DetailContent | null>(null);
  const [visible, setVisible] = useState(false);

  const close = useCallback(() => {
    setVisible(false);
    // keep content mounted briefly so the slide-out transition can play
    setTimeout(() => setContent(null), 200);
  }, []);

  const open = useCallback((c: DetailContent) => {
    setContent(c);
    // next tick so transform transition triggers
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && visible) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, close]);

  const ctx = useMemo(() => ({ open, close }), [open, close]);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <div
        className={"overlay-scrim" + (visible ? " open" : "")}
        onClick={close}
        aria-hidden
      />
      <aside
        className={"detail" + (visible ? " open" : "")}
        aria-hidden={!visible}
      >
        {content && (
          <>
            <div className="detail-head">
              <div className="detail-titlewrap">
                <span className={"detail-title" + (content.mono ? " mono" : "")}>{content.title}</span>
                {content.sub && <span className="detail-sub">{content.sub}</span>}
              </div>
              <button className="topbar-action" onClick={close} aria-label="Close" title="Close (Esc)">
                <IconClose />
              </button>
            </div>
            <div className="detail-body">{content.body}</div>
          </>
        )}
      </aside>
    </Ctx.Provider>
  );
}
