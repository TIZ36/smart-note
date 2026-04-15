"""Fallback topic detection when AI enrichment is disabled.

Tries to extract a meaningful topic from text using keyword patterns.
Returns a free-form topic string, not a fixed enum.
"""

import re

# Credential patterns — highest priority (regex-based, very specific)
CREDENTIAL_PATTERNS = [
    r"sk-[a-zA-Z0-9\-]{20,}",
    r"key-[a-zA-Z0-9]{20,}",
    r"ghp_[a-zA-Z0-9]{36}",
    r"gho_[a-zA-Z0-9]{36}",
    r"AKIA[A-Z0-9]{16}",
    r"(?:api[_-]?key|token|password|secret|密钥|密码)\s*[:=]\s*\S+",
    r"Bearer\s+[a-zA-Z0-9\-._~+/]+=*",
    r"-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----",
    r"mongodb(\+srv)?://\S+:\S+@",
    r"postgres(ql)?://\S+:\S+@",
    r"mysql://\S+:\S+@",
    r"redis://:\S+@",
]

# Topic hint patterns — (keyword_list, topic_label)
TOPIC_HINTS = [
    (["todo", "待办", "跟进", "截止", "提醒", "待处理", "to do", "[ ]", "- [ ]"],
     None),  # None means use the first matched keyword as part of the topic
    (["需求", "验收", "prd", "story", "issue", "提测"],
     None),
    (["复盘", "经验", "踩坑", "总结", "教训", "排障"],
     None),
    (["部署", "deploy", "发布", "上线", "rollback"],
     None),
    (["配置", "config", "设置", "环境变量"],
     None),
    (["bug", "修复", "fix", "hotfix", "问题"],
     None),
]


def _has_credential_pattern(text: str) -> bool:
    for pattern in CREDENTIAL_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def detect_topic(text: str, context: str = "") -> tuple[str, bool]:
    """Detect a topic for the given text.

    Returns: (topic_string, is_credential)
    """
    # Check for credentials first
    if _has_credential_pattern(text):
        # Try to identify what service
        text_lower = text.lower()
        if "openai" in text_lower or text_lower.startswith("sk-"):
            return "OpenAI密钥", True
        if "github" in text_lower or "ghp_" in text or "gho_" in text:
            return "GitHub Token", True
        if "aws" in text_lower or "AKIA" in text:
            return "AWS密钥", True
        if "postgres" in text_lower or "mysql" in text_lower or "mongodb" in text_lower:
            return "数据库连接", True
        return "密钥凭证", True

    cred_words = ["api_key", "apikey", "api key", "secret", "密钥", "秘钥",
                  "token", "password", "密码", "access_key", "private_key", "凭证"]
    content_lower = text.lower()
    cred_hits = sum(1 for w in cred_words if w in content_lower)
    if cred_hits >= 2:
        return "密钥凭证", True

    # Extract a topic from content
    # Strategy: find the most descriptive noun phrase or action
    # Use the first meaningful segment before any colon/separator
    stripped = text.strip()

    # If text starts with a label pattern like "topic: content" or "topic：content"
    label_match = re.match(r'^([^:：]{2,20})[:：]\s*(.+)', stripped, re.DOTALL)
    if label_match:
        label = label_match.group(1).strip()
        rest = label_match.group(2).strip()
        # If label is a generic prefix, use the content after it
        generic = {"todo", "需求", "备注", "note", "记录", "笔记", "提醒"}
        if label.lower() in generic and rest:
            topic = rest[:20]
            for sep in ["。", "，", "；", ",", ";", " "]:
                idx = topic.find(sep)
                if 4 <= idx <= 18:
                    topic = topic[:idx]
                    break
            return topic.strip(), False
        if label:
            return label, False

    # Try to find a project name
    project_match = re.search(
        r"([a-zA-Z0-9_\-\u4e00-\u9fff]{2,})项目", f"{context} {text}"
    )
    if project_match:
        return f"{project_match.group(1)}项目", False

    # Fallback: use the first 15 chars as topic (truncated at word boundary)
    topic = stripped[:30]
    # Cut at sentence boundary
    for sep in ["。", "，", "；", ",", ";", " ", "\n"]:
        idx = topic.find(sep)
        if 4 <= idx <= 25:
            topic = topic[:idx]
            break
    if len(topic) > 20:
        topic = topic[:20]

    return topic.strip() or "笔记", False


# Keep backward compatibility — old code uses detect_dimension
def detect_dimension(text: str, context: str = "") -> tuple[str, str | None]:
    """Legacy wrapper. Returns (topic, None) for backward compat."""
    topic, _ = detect_topic(text, context)
    return topic, None
