import AppKit

final class GlassShapeView: NSView {
    private let blur = NSVisualEffectView()
    private let reversedRim = NSVisualEffectView()
    private let rimMask = CAShapeLayer()
    private let highlight = CAGradientLayer()
    private var radius: CGFloat = 20

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true

        for effect in [blur, reversedRim] {
            effect.blendingMode = .behindWindow
            effect.material = .hudWindow
            effect.state = .active
            effect.appearance = NSAppearance(named: .darkAqua)
            effect.wantsLayer = true
            addSubview(effect)
        }
        reversedRim.alphaValue = 0.82
        reversedRim.layer?.setAffineTransform(CGAffineTransform(scaleX: -1.045, y: 1.035))
        reversedRim.layer?.mask = rimMask

        highlight.colors = [
            NSColor.white.withAlphaComponent(0.72).cgColor,
            NSColor.white.withAlphaComponent(0.08).cgColor,
            NSColor.black.withAlphaComponent(0.16).cgColor,
            NSColor.white.withAlphaComponent(0.34).cgColor,
        ]
        highlight.locations = [0, 0.34, 0.72, 1]
        highlight.startPoint = CGPoint(x: 0.05, y: 1)
        highlight.endPoint = CGPoint(x: 0.95, y: 0)
        layer?.addSublayer(highlight)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(radius: CGFloat) {
        self.radius = radius
        needsLayout = true
    }

    override func layout() {
        super.layout()
        blur.frame = bounds
        reversedRim.frame = bounds
        layer?.cornerRadius = radius
        blur.layer?.cornerRadius = radius
        reversedRim.layer?.cornerRadius = radius
        highlight.frame = bounds

        let outer = CGPath(roundedRect: bounds.insetBy(dx: 0.7, dy: 0.7), cornerWidth: radius, cornerHeight: radius, transform: nil)
        let innerRect = bounds.insetBy(dx: 5.5, dy: 5.5)
        let inner = CGPath(roundedRect: innerRect, cornerWidth: max(2, radius - 5), cornerHeight: max(2, radius - 5), transform: nil)
        let ring = CGMutablePath()
        ring.addPath(outer)
        ring.addPath(inner)
        rimMask.path = ring
        rimMask.fillRule = .evenOdd
        rimMask.fillColor = NSColor.white.cgColor
    }
}

final class GlassCanvasView: NSView {
    private let bar = GlassShapeView()
    private let navigation = GlassShapeView()
    private let close = GlassShapeView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        for view in [bar, navigation, close] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(width: CGFloat, height: CGFloat, expanded: Bool, compact: Bool, chatbarHeight: CGFloat) {
        frame = NSRect(x: 0, y: 0, width: width, height: height)
        if compact {
            bar.frame = bounds.insetBy(dx: 3, dy: 3)
            bar.configure(radius: min(21, height / 2))
            navigation.isHidden = true; close.isHidden = true
            return
        }
        bar.isHidden = false
        bar.frame = NSRect(x: 16, y: 5, width: max(80, width - 32), height: max(56, min(chatbarHeight, height - 10)))
        bar.configure(radius: 20)
        navigation.isHidden = !expanded; close.isHidden = !expanded
        if expanded {
            let top = max(6, height - 46)
            let navigationWidth = max(300, width - 105)
            navigation.frame = NSRect(x: 32, y: top, width: navigationWidth, height: 36)
            navigation.configure(radius: 14)
            close.frame = NSRect(x: 39 + navigationWidth, y: top + 1, width: 34, height: 34)
            close.configure(radius: 17)
        }
    }
}

@MainActor
final class GlassAppDelegate: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    let canvas = GlassCanvasView(frame: NSRect(x: 0, y: 0, width: 590, height: 140))

    func applicationDidFinishLaunching(_ notification: Notification) {
        panel = NSPanel(contentRect: canvas.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = canvas
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue - 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.orderFrontRegardless()
        readCommands()
    }

    func readCommands() {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.apply(value) }
            }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
    }

    func apply(_ value: [String: Any]) {
        guard let x = value["x"] as? Double, let topY = value["y"] as? Double,
              let width = value["width"] as? Double, let height = value["height"] as? Double else { return }
        let screenTop = (value["screenTop"] as? Double) ?? 0
        let screenHeight = (value["screenHeight"] as? Double) ?? Double(NSScreen.main?.frame.height ?? 982)
        let cocoaY = screenTop + screenHeight - (topY - screenTop) - height
        canvas.update(width: width, height: height, expanded: (value["expanded"] as? Bool) ?? false, compact: (value["compact"] as? Bool) ?? false, chatbarHeight: (value["chatbarHeight"] as? Double) ?? 56)
        panel.setFrame(NSRect(x: x, y: cocoaY, width: width, height: height), display: true)
        panel.orderFrontRegardless()
    }
}

@main
struct GymstantGlassHost {
    static func main() {
        let app = NSApplication.shared
        let delegate = GlassAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
