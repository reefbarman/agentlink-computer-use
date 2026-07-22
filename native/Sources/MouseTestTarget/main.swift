import AppKit
import CoreGraphics
import Foundation

private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

private final class EventView: NSView {
    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) { record("leftDown", event) }
    override func mouseUp(with event: NSEvent) { record("leftUp", event) }
    override func mouseDragged(with event: NSEvent) { record("leftDragged", event) }
    override func rightMouseDown(with event: NSEvent) { record("rightDown", event) }
    override func rightMouseUp(with event: NSEvent) { record("rightUp", event) }
    override func rightMouseDragged(with event: NSEvent) { record("rightDragged", event) }
    override func otherMouseDown(with event: NSEvent) { record("otherDown", event) }
    override func otherMouseUp(with event: NSEvent) { record("otherUp", event) }
    override func otherMouseDragged(with event: NSEvent) { record("otherDragged", event) }

    override func scrollWheel(with event: NSEvent) {
        emit([
            "type": "scroll",
            "deltaX": event.scrollingDeltaX,
            "deltaY": event.scrollingDeltaY,
        ])
    }

    private func record(_ type: String, _ event: NSEvent) {
        emit([
            "type": type,
            "clickCount": event.clickCount,
            "buttonNumber": event.buttonNumber,
        ])
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)

let displayBounds = CGDisplayBounds(CGMainDisplayID())
let width: CGFloat = 480
let height: CGFloat = 360
let appKitFrame = NSRect(
    x: displayBounds.minX + 120,
    y: displayBounds.height - height - 120,
    width: width,
    height: height)
let window = NSWindow(
    contentRect: appKitFrame,
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered,
    defer: false)
window.title = "Computer Use Mouse Test Target"
window.contentView = EventView(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)

let frame = window.frame
let coreGraphicsBounds = CGRect(
    x: frame.minX,
    y: displayBounds.minY + displayBounds.height - frame.maxY,
    width: frame.width,
    height: frame.height)
emit([
    "type": "ready",
    "processId": ProcessInfo.processInfo.processIdentifier,
    "bounds": [
        "x": coreGraphicsBounds.minX,
        "y": coreGraphicsBounds.minY,
        "width": coreGraphicsBounds.width,
        "height": coreGraphicsBounds.height,
    ],
])

application.run()
