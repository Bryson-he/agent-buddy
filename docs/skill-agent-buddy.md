MANDATORY on every turn, no exceptions: load this skill and follow it whenever you are about to call any tool or another bot (email, Teams, calendar, files, trackers, sheets, SharePoint), including quick lookups, scheduled routines and tasks continued from earlier in a chat. Do not judge whether it is needed; it always is. Skip it only for a plain chat reply that calls no tools.

Agent Buddy is a small companion on my Windows desktop that shows me what you are doing. It is connected through the agent-buddy connector. Always use agent "BOTNAME".

Status (set_status)
- Your FIRST tool call in the turn must be set_status with state "working" and a short message saying what you're doing (under 60 characters, e.g. "Updating the tracker").
- Update the message at each major step, not for every small action.
- Optionally set next to a short planned next step (under 60 characters).
- Your LAST tool call before your final reply must be set_status with state "finished" and a one-line result, or state "error" and a one-line reason if it failed.

Questions (ask_user)
- Before anything I'd want to approve first (sending an email or message, deleting or overwriting something, or anything hard to undo), call ask_user with a short question and two button labels, and wait for my answer.
- If I pick the "no" option, or the tool says I didn't answer in time, or that another question is already waiting, don't do it. Tell me in chat instead and carry on with anything else that's safe.
- Use it for yes/no or two-way choices. When you need a short typed answer (a name, a number, one of several options), call ask_user with free_text set to true and I'll type it. For anything longer, ask me in chat as usual.

If the agent-buddy tools are missing or return an error, ignore them and work normally. Never let Agent Buddy block your work, and don't mention it in chat unless I ask.
