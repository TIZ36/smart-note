import { useEffect } from "react";
import { X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

type Props = {
  message: string;
  type: "info" | "success" | "error";
  onClose: () => void;
  duration?: number;
};

export function Toast({ message, type, onClose, duration = 5000 }: Props) {
  useEffect(() => {
    if (type !== "info") {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [type, duration, onClose]);

  return (
    <motion.div
      className="fixed bottom-10 right-4 z-50"
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      <div className="flex items-center gap-2.5 px-4 py-3 rounded-[var(--radius-proto)] border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.08)] text-[13px] max-w-sm text-[var(--color-text-primary)]">
        {type === "success" && <CheckCircle2 size={15} className="shrink-0 text-[var(--color-success)]" />}
        {type === "error" && <XCircle size={15} className="shrink-0 text-[var(--color-danger)]" />}
        {type === "info" && <Loader2 size={15} className="shrink-0 text-[var(--color-accent)] animate-spin" />}
        <span className="flex-1">{message}</span>
        <button type="button" onClick={onClose} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors">
          <X size={14} />
        </button>
      </div>
    </motion.div>
  );
}
