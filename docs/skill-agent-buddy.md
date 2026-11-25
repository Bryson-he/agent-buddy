MANDATORY on every turn, no exceptions: load this skill and follow it before you ask me any question with choices (your question card counts) and whenever you are about to call any tool or another bot (email, Teams, calendar, files, trackers, sheets, SharePoint), including quick lookups, scheduled routines and tasks continued from earlier in a chat. Do not judge whether it is needed; it always is. Skip it only for a plain chat reply that calls no tools and asks me nothing to choose.

Agent Buddy is a small companion on my Windows desktop that shows me what you are doing. It is connected through the agent-buddy connector. Always use agent "BOTNAME".

Status (set_status)
- Your FIRST tool call in the turn must be set_status with state "working" and a short message saying what you're doing (under 60 characters, e.g. "Updating the tracker").
- Update the message at each major step, not for every small action.
- Optionally set next to a short planned next step (under 60 characters).
- Your LAST tool call before your final reply must be set_status with state "finished" and a one-line result, or state "error" and a one-line reason if it failed.
- ALWAYS read what set_status returns. It can carry a message I left for you on Agent Buddy, or tell you I pressed Pause or Stop. Follow it straight away, ahead of what you were about to do: on Stop, start no further steps and report what is done; on Pause, finish the step you are on and wait for me in chat; a message is an instruction from me.
- For a job you can count (rows, files, devices), pass progress with done and total, and update it as you go.
- When you finish something I may want to open (a sheet, a tracker, a folder), pass its web address as link with a short link_label such as "Open tracker".
- Use urgency "quiet" for a routine or scheduled check that found nothing to report, and "urgent" only when something needs me soon.

Questions (ask_user)
- Before anything I'd want to approve first (sending an email or message, deleting or overwriting something, or anything hard to undo), call ask_user with a short question and two button labels, and wait for my answer.
- If I pick the "no" option, or the tool says I didn't answer in time, or that too many questions are already waiting, don't do it. Tell me in chat instead and carry on with anything else that's safe.
- For yes/no or two-way choices, pass two short button labels.
- MANDATORY: whenever you are about to ask me a question with choices, including with your own question card or any "pick one" prompt in chat, you must FIRST call agent-buddy ask_user with the same question (one sentence) and the same two to four options (each under 80 characters), with allow_other set to true. Do this before you end your turn, and do not set your status to "finished" first: I am usually not looking at the chat, so a question asked only in chat does not reach me.
- If I answer on Agent Buddy, that is my answer: carry on with it and do not ask again in chat. Only if ask_user says I did not answer, or the tool fails, ask in chat with your question card as usual.
- When I may pick more than one of the options, set multi_select to true.
- When the choice needs background (the draft you want to send, the rows affected), put it in detail, up to a few short lines.
- When you need a short typed answer (a name, a number), call ask_user with free_text set to true and I'll type it.
- If ask_user says I am away, ask in chat with your question card instead, and do nothing risky until I answer.
- If the tool says the question is still waiting, call ask_user again with exactly the same question, options and agent, and keep doing that until you get an answer or it says I did not answer. It is not shown to me twice.

Reminders (remind_user)
- When I ask to be reminded of something, or something needs my eyes later (a follow-up that is due, a check to repeat), call remind_user with the text and either in_minutes or at ("HH:MM", 24 hour).

If the agent-buddy tools are missing or return an error, ignore them and work normally. Never let Agent Buddy block your work, and don't mention it in chat unless I ask.
