# Transcript fixtures

These files are **synthetic**. They reproduce the record shapes that Claude Code and
Codex write, with invented content.

Real transcripts are the user's conversations: they contain source code, file paths,
and whatever was discussed. None of that belongs in a repository, so no captured
transcript is committed here — the shapes were read from real files locally and
rewritten by hand.

`__CWD__` is replaced with a temporary workspace path when a test installs the
fixture, because both agents record absolute paths and one of them (Codex) is matched
to a workspace by that path.

Both formats are undocumented and change between releases. When a new shape shows up,
add a dated fixture next to the existing ones rather than editing them: the old file
keeps proving that the parser still handles what it used to.
