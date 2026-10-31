import Carbon
import Darwin
import Foundation

struct FocusState: Codable {
    var order: UInt64 = 0
    var owner: String?
    var restore: String?
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 3,
      arguments[0] == "enter" || arguments[0] == "leave",
      let order = UInt64(arguments[1]) else {
    fputs("Usage: select-input-source enter|leave timestamp owner\n", stderr)
    exit(1)
}
let action = arguments[0]
let owner = arguments[2]

// Never replace the lock inode. Selection and restore-state updates must be
// serialized across all pi processes, including transfers between pi tabs.
let stateURL = FileManager.default.temporaryDirectory.appendingPathComponent("pi-auto-chinese-\(getuid()).state")
let stateFD = open(stateURL.path, O_RDWR | O_CREAT | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard stateFD >= 0 else {
    perror("Could not open input source state")
    exit(1)
}
defer { close(stateFD) }
guard flock(stateFD, LOCK_EX) == 0 else {
    perror("Could not lock input source state")
    exit(1)
}
defer { flock(stateFD, LOCK_UN) }
let file = FileHandle(fileDescriptor: stateFD, closeOnDealloc: false)
let previousData = file.readDataToEndOfFile()
// The previous extension stored just a timestamp. It has no restore source.
var state = (try? JSONDecoder().decode(FocusState.self, from: previousData)) ?? FocusState()
if state.order >= order { exit(0) }

func currentSourceID() -> String? {
    let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    guard let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return nil }
    return Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue() as String
}

var sourceID: String?
if action == "enter" {
    if state.owner == nil {
        guard let current = currentSourceID() else {
            fputs("Could not read current input source\n", stderr)
            exit(1)
        }
        state.restore = current
    }
    state.owner = owner
    sourceID = "com.tencent.inputmethod.wetype.pinyin"
} else if state.owner == owner {
    sourceID = state.restore
    state.owner = nil
    state.restore = nil
}
// A late leave from a different pi tab must not restore over the active tab.
if let sourceID = sourceID {
    guard let result = TISCreateInputSourceList(nil, false) else {
        fputs("Could not read enabled input sources\n", stderr)
        exit(1)
    }
    let sources = result.takeRetainedValue() as NSArray
    var selected = false
    for item in sources {
        let source = item as! TISInputSource
        guard let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { continue }
        let identifier = Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue() as String
        if identifier == sourceID {
            let status = TISSelectInputSource(source)
            guard status == noErr else {
                fputs("Could not select input source (OSStatus \(status))\n", stderr)
                exit(1)
            }
            selected = true
            break
        }
    }
    guard selected else {
        fputs("Input source is not enabled: \(sourceID)\n", stderr)
        exit(1)
    }
}
state.order = order
do {
    let data = try JSONEncoder().encode(state)
    try file.seek(toOffset: 0)
    try file.truncate(atOffset: 0)
    try file.write(contentsOf: data)
} catch {
    fputs("Could not save input source state: \(error)\n", stderr)
    exit(1)
}
