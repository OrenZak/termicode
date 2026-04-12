# Lessons

- When evolving a single-provider integration into a multi-provider surface, extract provider metadata first and let commands, session persistence, and UI read from that registry instead of branching on provider names ad hoc.
- Preserve backward compatibility for persisted session state during provider migrations by accepting the old saved fields and rewriting them into the new generic schema on restore.
- Never trust a configured CLI path blindly. Validate it before launch, fall back to real executable discovery when possible, and block session startup behind install/repair flows so PTY boot errors stay user-facing and recoverable.
- When adding a “default” flow on top of a chooser UX, keep an explicit override command so power users can move fast with a favorite provider without losing access to one-off alternatives.
