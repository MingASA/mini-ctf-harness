# Runtime prompts

`system_prompt.txt` is the stable solving prompt. Pi's native `formatSkillsForPrompt` replaces `{{SKILL_CATALOG}}` with the project skill catalog in skill-enabled mode.

`compact_initial.txt` and `compact_update.txt` are temporary final user messages for first and subsequent Compact calls. Each requests exactly nine ordered string fields, matching `src/compact-prompts.mjs`. The existing system prompt, tool definitions and full conversation prefix are retained; tools are disabled for this generation.

The original supplied archive receipt is provenance for its historical contents. These active prompts were revised under the operator's later instructions. Original revisions remain in Git and completed experiment evidence.
