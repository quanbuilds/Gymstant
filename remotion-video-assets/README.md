# Remotion demo inputs

These are the small, repo-local inputs for the Gymstant product demo. Use the real UI as the source of truth. The current landing-page demo is included only as a reference for what to replace.

## What is here

- `screenshots/gymstant-watching.png` — Gymstant floating beside the desktop while a workflow is being watched.
- `screenshots/gymstant-reviewing-class-software.png` — Gymstant reviewing a captured workflow beside the class-management system.
- `recordings/gymstant-watch-workflow.mp4` — 16-second real Gymstant watch-state clip.
- `recordings/gymstant-review-workflow.mp4` — 30-second real Gymstant review-state clip with the class software visible.
- `recordings/ava-bennett-missed-class-workflow.mov` — original 2:14 portrait recording of the Ava Bennett missed-class workflow.
- `recordings/ava-bennett-missed-class-workflow.txt` — Whisper transcript of the Ava Bennett recording.
- `recordings/current-landing-demo-reference.mp4` — the existing landing-page demo. Do not use this as the final structure; it is here only to compare against the new workflow-led cut.

## Intended story

Build a 60–90 second product demo around one real front-desk task:

1. Staff asks Gymstant to handle a missed-class makeup.
2. Gymstant watches the staff member find the student, confirm the absence, check the makeup class, and prepare the parent message.
3. Gymstant turns the observed actions into an editable workflow in Review.
4. Staff asks what was verified, and Gymstant answers only from the evidence it actually captured.
5. Staff runs the workflow again. Gymstant stops before the final consequential action so a person can approve it.

## Source recordings on this Mac

The longer originals remain on the desktop and are not duplicated into the repo:

- `Screen Recording 2026-07-18 at 7.39.17 AM.mov` — Gymstant watch experience.
- `Screen Recording 2026-07-18 at 7.55.20 AM.mov` — class software navigation and Gymstant review context.
- `Screen Recording 2026-07-18 at 8.06.07 AM.mov` — Education/class-software workflow with Gymstant Review visible.

Use the repo-local MP4s first. Pull from the longer originals only when a precise action or transition is needed.

## Constraints

- Show real UI and real state changes. No invented dashboards or fake assistant answers.
- Do not claim a numeric time saving unless it is measured in the footage.
- Make the saved effort visible through fewer repeated searches, fewer re-checks, and a reusable workflow.
- Keep the final save/send/approval human-controlled.
- Use Gymstant green and purple for labels, highlights, transitions, and backgrounds.
