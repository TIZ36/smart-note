import { useState, useEffect } from "react";
import { FileText, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { readTextFile, openPath } from "@/lib/electron";

type Props = {
  viewKey: string;
  title: string;
  path: string;
};

export function ViewPanel({ title, path }: Props) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    readTextFile(path)
      .then((result) => setContent(result.output || ""))
      .catch(() => setContent("Failed to load view."))
      .finally(() => setLoading(false));
  }, [path]);

  const fileName = path.split("/").pop() ?? path;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="proto-view-header">
        <span>{title}</span>
        <span className="proto-view-header-file">{fileName}</span>
        <button type="button" onClick={() => openPath(path)} className="proto-view-open">
          Open file
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="proto-view-content">
          {loading ? (
            <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
              <Loader2 size={15} className="animate-spin" />
              <span className="text-[13px]">Loading...</span>
            </div>
          ) : content ? (
            <motion.div className="markdown-content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
              <ReactMarkdown>{content}</ReactMarkdown>
            </motion.div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-[var(--color-text-muted)] gap-2">
              <FileText size={32} className="opacity-30" />
              <p className="text-[13px]">This view is empty.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
