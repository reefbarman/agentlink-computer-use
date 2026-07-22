import CoreGraphics

let nativeInputEventUserData: Int64 = 0x4355_4D43

func tagNativeInputEvent(_ event: CGEvent) {
    event.setIntegerValueField(
        .eventSourceUserData,
        value: nativeInputEventUserData)
}
