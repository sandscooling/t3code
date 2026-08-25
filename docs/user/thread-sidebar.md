# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Session groups

Sessions that an agent started with the orchestration tools share a group, usually named for the
ticket or task they belong to. The sidebar shows a group's sessions together under a header with
the group name and a live count, such as `T-1234 3/5 live`. Click the header to collapse or
expand the group; the choice is remembered per group.

Each session in a group carries a small dot: green while a process is running behind it, muted
once it has stopped. A stopped session is still there and keeps its history; sending it a message,
or having the orchestrator wake it, starts a fresh process under the same name. See
[Agent orchestration](agent-orchestration.md).

Grouped sessions that are pinned, snoozed, or settled appear in those sections rather than under
the group header.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
