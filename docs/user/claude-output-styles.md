# Claude output styles

An output style changes how Claude writes its replies. It does not change which model
runs or what the agent is allowed to do.

Pick one next to the other Claude traits, under the composer's model controls or in
Thread settings on mobile. The picker appears once at least one style beyond the
built-ins exists. Write your own as a Markdown file with a `name` and `description` in
the `output-styles` folder of the Claude config directory, such as
`~/.claude/output-styles/team-voice.md`. Refresh providers in Settings if a new style
does not appear.

The style belongs to the thread, so two threads can run two different styles at once.
This differs from running `/output-style` in Claude Code, which writes the choice to a
shared settings file. New threads inherit the style you picked last; set a thread back
to **Default** to let Claude write as it normally would. A change applies from the next
message you send.

See [Claude](providers-claude.md) for setting up the Claude provider itself.
