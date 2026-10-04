#!/usr/bin/env python3
# 在 GitHub Actions runner 上运行：把 aycho-gateway 部署为 Hugging Face Docker Space
# 本云环境无法访问 huggingface.co，故借道 Actions（runner 出网不受限）
import os, sys, time

from huggingface_hub import HfApi

TOKEN = os.environ.get("HF_TOKEN", "").strip()
if not TOKEN:
    print("!! 缺少 HF_TOKEN（GitHub 仓库 secret 未设置）"); sys.exit(2)

api = HfApi(token=TOKEN)
who = api.whoami()
OWNER = who.get("name")
print("HF 账号:", OWNER, "| token 类型:", who.get("type"), "| 权限:", (who.get("auth") or {}).get("accessToken", {}).get("role"))
REPO_ID = "%s/aycho-gateway" % OWNER

# 1) 创建/复用 Space（Docker SDK，公开）
try:
    api.create_repo(repo_id=REPO_ID, repo_type="space", space_sdk="docker",
                    private=False, exist_ok=True)
    print("Space 就绪:", REPO_ID)
except Exception as e:
    print("create_repo 失败:", e)
    if "already" not in str(e).lower():
        sys.exit(3)

# 2) 上传代码（排除敏感与无关文件）
api.upload_folder(
    folder_path=".",
    repo_id=REPO_ID, repo_type="space",
    ignore_patterns=[".git/*", ".github/*", "hf-deploy/*", ".env", "**/.env",
                     "node_modules/*", "**/node_modules/*", "*.log", "data/*",
                     "*.bak", "refs/*"],
    commit_message="deploy: aycho-gateway -> HF Space",
)
print("代码上传完成")

# 3) Space 元数据 README（app_port 让 HF 知道对外端口）
meta = """---
title: Aycho Gateway
emoji: 🛰️
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Aycho Gateway

AYCHO 网页工作台的真实后端网关：认证 / 邮箱验证码 / 大模型对话 / 文件 API / 分享 / 浏览器代理 / 终端。
"""
api.upload_file(path_or_fileobj=meta.encode("utf-8"), path_in_repo="README.md",
                repo_id=REPO_ID, repo_type="space", commit_message="docs: space metadata")
print("README 元数据写入完成")

# 4) 敏感项 -> Space Secrets；普通项 -> Space Variables
SECRETS = ["AYCHO_MODEL_API_KEY", "AYCHO_SMTP_PASS", "AYCHO_SMTP_USER"]
VARS = {
    "AYCHO_MODEL_BASE_URL": os.environ.get("AYCHO_MODEL_BASE_URL", ""),
    "AYCHO_MODEL_NAME": os.environ.get("AYCHO_MODEL_NAME", ""),
    "AYCHO_SMTP_HOST": "smtp.qq.com",
    "AYCHO_SMTP_PORT": "465",
    "AYCHO_MAIL_FROM": os.environ.get("AYCHO_MAIL_FROM", ""),
    "AYCHO_MAIL_FROM_NAME": "AYCHO",
    "AYCHO_MAIL_CHANNEL": "smtp",
    "AYCHO_CORS": "*",
    "AYCHO_SHARE_BASE": "https://%s-aycho-gateway.hf.space" % OWNER.replace("_", "-").replace(".", "-"),
}
for k in SECRETS:
    v = os.environ.get(k, "")
    if v:
        api.add_space_secret(repo_id=REPO_ID, key=k, value=v,
                             description="injected by GitHub Actions")
        print("secret 已设置:", k)
    else:
        print("跳过（空）:", k)
for k, v in VARS.items():
    if v:
        try:
            api.add_space_variable(repo_id=REPO_ID, key=k, value=v)
        except Exception as e:
            print("variable 失败", k, e)
print("变量写入完成")

print("SPACE_URL=https://%s-aycho-gateway.hf.space" % OWNER.replace("_", "-").replace(".", "-"))
print("SPACE_PAGE=https://huggingface.co/spaces/%s" % REPO_ID)

# re-deploy trigger: 2026-10-04 18:57:02
