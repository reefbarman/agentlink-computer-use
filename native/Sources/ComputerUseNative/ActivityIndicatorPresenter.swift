import AppKit
import CoreGraphics
import Foundation

@MainActor
private final class ActivityPillView: NSView {
    private static let labelFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
    static let preferredWidth = ceil(
        ("Computer use: viewing screen" as NSString).size(
            withAttributes: [.font: labelFont]).width + 42)

    var activity: ComputerUseActivity = .idle {
        didSet { needsDisplay = true }
    }

    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard activity != .idle else { return }

        let background = NSBezierPath(
            roundedRect: bounds.insetBy(dx: 1, dy: 1),
            xRadius: bounds.height / 2,
            yRadius: bounds.height / 2)
        NSColor.black.withAlphaComponent(0.86).setFill()
        background.fill()

        let color: NSColor = activity == .capture ? .systemOrange : .systemRed
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: 12, y: 11, width: 10, height: 10)).fill()

        let text: String
        switch activity {
        case .capture:
            text = "Computer use: viewing screen"
        case .control:
            text = "Computer use: controlling"
        case .paused:
            text = "Computer use stopped"
        case .idle:
            return
        }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: Self.labelFont,
            .foregroundColor: NSColor.white,
        ]
        text.draw(at: NSPoint(x: 30, y: 8), withAttributes: attributes)
    }
}

@MainActor
final class ActivityIndicatorPresenter: NSObject {
    var onEmergencyStop: (() -> Void)?
    var onResumeControl: (() -> Void)?

    private let statusItem: NSStatusItem
    private var panels: [NSScreen: NSPanel] = [:]
    private var currentState: ComputerUseActivity = .idle
    private var inputEnabled = true
    private var screenObserver: NSObjectProtocol?
    private(set) var isAvailable = false

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()

        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.finishLaunching()
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "record.circle", accessibilityDescription: "Computer use")
            button.toolTip = "Computer use is idle"
        }
        statusItem.menu = NSMenu()
        rebuildPanels()
        rebuildMenu()
        isAvailable = statusItem.button != nil && !panels.isEmpty

        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.rebuildPanels()
                self?.isAvailable =
                    self?.statusItem.button != nil && !(self?.panels.isEmpty ?? true)
                self?.applyPresentation()
            }
        }
    }

    func update(state: ComputerUseActivity, inputEnabled: Bool) {
        currentState = state
        self.inputEnabled = inputEnabled
        applyPresentation()
        rebuildMenu()
    }

    func verifyVisible() throws {
        let visibleWindowNumbers = Set(
            (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
                as? [[String: Any]] ?? []).compactMap {
                    $0[kCGWindowNumber as String] as? Int
                })
        let missingPanels = panels.values.filter {
            !$0.isVisible || !visibleWindowNumbers.contains($0.windowNumber)
        }
        guard missingPanels.isEmpty else {
            isAvailable = false
            applyPresentation()
            throw SpikeError.unsupported(
                "Computer-use activity indicator could not be made visible")
        }
    }

    func cleanup() {
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
            self.screenObserver = nil
        }
        panels.values.forEach { $0.orderOut(nil) }
        panels.removeAll()
        NSStatusBar.system.removeStatusItem(statusItem)
        isAvailable = false
    }

    private func rebuildPanels() {
        let screens = Set(NSScreen.screens)
        for (screen, panel) in panels where !screens.contains(screen) {
            panel.orderOut(nil)
            panels.removeValue(forKey: screen)
        }
        for screen in screens where panels[screen] == nil {
            panels[screen] = makePanel(for: screen)
        }
        for (screen, panel) in panels {
            position(panel, on: screen)
        }
    }

    private func makePanel(for screen: NSScreen) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(
                x: 0, y: 0, width: ActivityPillView.preferredWidth, height: 32),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false,
            screen: screen)
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [
            .canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle,
        ]
        panel.sharingType = .none
        panel.contentView = ActivityPillView(frame: panel.contentView?.bounds ?? .zero)
        panel.contentView?.autoresizingMask = [.width, .height]
        return panel
    }

    private func position(_ panel: NSPanel, on screen: NSScreen) {
        let frame = screen.visibleFrame
        panel.setFrameOrigin(
            NSPoint(
                x: frame.maxX - panel.frame.width - 12,
                y: frame.maxY - panel.frame.height - 12))
    }

    private func applyPresentation() {
        for panel in panels.values {
            (panel.contentView as? ActivityPillView)?.activity = currentState
            if currentState == .idle {
                panel.orderOut(nil)
            } else {
                panel.orderFrontRegardless()
            }
        }

        guard let button = statusItem.button else { return }
        let symbol: String
        let color: NSColor
        switch currentState {
        case .idle:
            symbol = inputEnabled ? "record.circle" : "hand.raised.fill"
            color = inputEnabled ? .secondaryLabelColor : .systemRed
            button.toolTip = inputEnabled ? "Computer use is idle" : "Computer control is paused"
        case .capture:
            symbol = "eye.fill"
            color = .systemOrange
            button.toolTip = "Computer use is viewing the screen"
        case .control:
            symbol = "cursorarrow.motionlines"
            color = .systemRed
            button.toolTip = "Computer use is controlling this Mac"
        case .paused:
            symbol = "hand.raised.fill"
            color = .systemRed
            button.toolTip = "Computer control is paused"
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: button.toolTip)
        image?.isTemplate = false
        button.image = image?.withSymbolConfiguration(
            NSImage.SymbolConfiguration(paletteColors: [color]))
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let stateItem = NSMenuItem(
            title: statusTitle,
            action: nil,
            keyEquivalent: "")
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        if inputEnabled {
            let stop = NSMenuItem(
                title: "Emergency Stop",
                action: #selector(emergencyStopSelected),
                keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
        } else {
            let resume = NSMenuItem(
                title: "Resume Control",
                action: #selector(resumeControlSelected),
                keyEquivalent: "")
            resume.target = self
            menu.addItem(resume)
        }
        statusItem.menu = menu
    }

    private var statusTitle: String {
        switch currentState {
        case .idle: return inputEnabled ? "Computer use: Idle" : "Computer use: Paused"
        case .capture: return "Computer use: Viewing screen"
        case .control: return "Computer use: Controlling"
        case .paused: return "Computer use: Paused"
        }
    }

    @objc private func emergencyStopSelected() {
        onEmergencyStop?()
    }

    @objc private func resumeControlSelected() {
        onResumeControl?()
    }
}
