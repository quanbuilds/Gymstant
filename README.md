# Gymstant prototype

Gymstant is a domain-neutral workflow learning shell, initially presented for gymnastics gyms. It floats above existing software and moves captured procedures through four explicit states: **Learn → Review → Monitor → Automated**.

The shell is an ambient component layer rather than a traditional application window. Drag the center grip to reposition the entire component stack. Drag either side rail to resize from the lane-switcher minimum to the operating system work area. Conversation and workflow components always open above the composer and clamp themselves to the active display.

The composer is always the bottom edge of the component. Conversation content grows upward and becomes scrollable at the work-area ceiling. Dragging the center grip temporarily retracts the conversation; use the top conversation rail to adjust its height.

## Run

```bash
npm install
npm run dev
```

macOS will request Screen Recording permission when the first screenshot is captured. Use **Command–Shift–G** after each meaningful action while teaching, or press **Capture step** in the expanded overlay.

Action prompts run through the isolated Hermes profile at `~/.hermes/profiles/gymstant`. Hermes supplies the execution runtime while Gymstant retains the interface, workflow state, evidence, review lane, and consequential-action gate. The liquid-lens components sample the active desktop locally after launch and shift that sample continuously while dragging, then recapture after resize or release.

Runtime routing is intentionally split: ordinary text uses the on-device Gemma 4 12B fast tier, while actionable desktop requests launch the isolated Hermes profile with only the `computer_use` schema. During execution Gymstant pauses its lens sampler and moves to a small work-status pill at the edge of the active display, then restores its prior bounds when a response is ready. This avoids covering target controls and prevents ScreenCaptureKit contention with CuaDriver.

On macOS, desktop control belongs to `/Applications/CuaDriver.app` (`com.trycua.driver`). Grant that app Accessibility and Screen Recording independently of the Gymstant/Electron permission. Verify with `gymstant computer-use doctor`.

## Prototype boundaries

- Screenshots, workflow state, and the append-only `MEMORY.md` live locally under Electron's Gymstant application-data directory.
- Password and payment-entry capture must remain excluded in the production observer.
- Approval moves a workflow to Monitor. Monitor runs still require the person to confirm the final consequential action.
- This prototype proves the overlay and workflow lifecycle. Continuous input-event capture, document ingestion, Playwright synthesis, OAuth, and signed installers are the next implementation layer.
- Packaging targets exist for macOS (`npm run pack:mac`), a Windows x64 application directory (`npm run pack:win`), and a Windows portable installer (`npm run pack:win:portable`). The final signed installer should be produced and smoke-tested on a Windows build lane before client delivery.
