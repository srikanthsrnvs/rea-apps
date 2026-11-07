import AppKit
import CoreServices

let bundleID = "org.rea.charts.login"
let nativeScheme = "tradingview" as CFString
let defaults = UserDefaults.standard

func currentHandler() -> String? {
    LSCopyDefaultHandlerForURLScheme(nativeScheme)?.takeRetainedValue() as String?
}

func restoreHandler() {
    // Do not undo a handler selected by the user or another app during login.
    if currentHandler() == bundleID,
       let previous = defaults.string(forKey: "previousNativeHandler"), !previous.isEmpty {
        _ = LSSetDefaultHandlerForURLScheme(nativeScheme, previous as CFString)
    }
    defaults.removeObject(forKey: "previousNativeHandler")
    defaults.removeObject(forKey: "nativeHandlerDeadline")
}

if CommandLine.arguments.contains("--register") {
    let previous = currentHandler()
    let status = LSRegisterURL(Bundle.main.bundleURL as CFURL, true)
    if let previous, previous != bundleID {
        _ = LSSetDefaultHandlerForURLScheme(nativeScheme, previous as CFString)
    }
    if status == noErr {
        let ownStatus = LSSetDefaultHandlerForURLScheme("rea-charts" as CFString, bundleID as CFString)
        print("{\"registered\":\(ownStatus == noErr)}")
        exit(ownStatus == noErr ? 0 : 1)
    }
    print("{\"registered\":false}"); exit(1)
}
if CommandLine.arguments.contains("--handler-status") {
    let result: [String: Any] = ["nativeHandler": currentHandler() ?? "", "receiver": bundleID]
    let data = try! JSONSerialization.data(withJSONObject: result)
    print(String(decoding: data, as: UTF8.self)); exit(0)
}
if CommandLine.arguments.contains("--test-native-handler") {
    let previous = currentHandler()
    let status = LSSetDefaultHandlerForURLScheme(nativeScheme, bundleID as CFString)
    let accepted = status == noErr && currentHandler() == bundleID
    if let previous { _ = LSSetDefaultHandlerForURLScheme(nativeScheme, previous as CFString) }
    print("{\"accepted\":\(accepted),\"hadPreviousHandler\":\(previous != nil),\"restored\":\(previous == nil || previous == currentHandler())}")
    exit(accepted && (previous == nil || previous == currentHandler()) ? 0 : 1)
}
if CommandLine.arguments.contains("--cancel-receiver") {
    restoreHandler()
    for application in NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        where application.processIdentifier != ProcessInfo.processInfo.processIdentifier { application.terminate() }
    print("{\"cancelled\":true}"); exit(0)
}

class LoginDelegate: NSObject, NSApplicationDelegate {
    var busy = false
    var timeout: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let deadline = defaults.double(forKey: "nativeHandlerDeadline")
        if deadline > 0 && deadline <= Date().timeIntervalSince1970 { restoreHandler() }
        if deadline > Date().timeIntervalSince1970 { armTimer(deadline) }
    }

    func armTimer(_ deadline: Double) {
        timeout?.invalidate()
        timeout = Timer.scheduledTimer(withTimeInterval: max(1, deadline - Date().timeIntervalSince1970), repeats: false) { _ in
            restoreHandler()
            NSApp.terminate(nil)
        }
    }

    func alert(_ title: String, _ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.runModal()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.count == 1, let url = urls.first,
              url.scheme == "rea-charts" || url.scheme == "tradingview" else { return }
        if busy { alert("Sign-in in progress", "Wait for the current sign-in response."); return }
        if url.scheme == "tradingview" && defaults.double(forKey: "nativeHandlerDeadline") <= Date().timeIntervalSince1970 {
            restoreHandler(); return
        }
        busy = true
        let isCallback = url.scheme == "tradingview"
        // The native callback is only passed through a pipe, never argv or logs.
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.bridge(url.absoluteString)
            DispatchQueue.main.async {
                self.busy = false
                if isCallback { restoreHandler(); self.timeout?.invalidate() }
                guard let result else {
                    self.alert("Sign-in needs attention", "The receiver could not complete its request. Check charts-client status --online before retrying.")
                    return
                }
                if result["action"] as? String == "open",
                   let approval = result["approvalUrl"] as? String,
                   let approvalURL = URL(string: approval),
                   let deadlineMs = result["expiresAt"] as? Double {
                    // The bridge checks the official origin, path, proof hash,
                    // configured host, login ID and expiry before this point.
                    let previous = currentHandler()
                    if previous != bundleID { defaults.set(previous ?? "", forKey: "previousNativeHandler") }
                    defaults.set(deadlineMs / 1000, forKey: "nativeHandlerDeadline")
                    defaults.synchronize()
                    if LSSetDefaultHandlerForURLScheme(nativeScheme, bundleID as CFString) != noErr || currentHandler() != bundleID {
                        restoreHandler()
                        self.alert("Unable to receive sign-in", "macOS did not allow this app to receive TradingView's callback.")
                        return
                    }
                    self.armTimer(deadlineMs / 1000)
                    if !NSWorkspace.shared.open(approvalURL) {
                        restoreHandler()
                        self.alert("Unable to open sign-in", "Your browser could not open TradingView's sign-in page.")
                    }
                } else if result["authenticated"] as? Bool == true {
                    self.alert("TradingView connected", "Your account is now available to Charts on the configured host.")
                    NSApp.terminate(nil)
                } else {
                    self.alert("Sign-in needs attention", result["message"] as? String ?? "Check charts-client status --online.")
                }
            }
        }
    }

    func bridge(_ value: String) -> [String: Any]? {
        guard let executable = Bundle.main.object(forInfoDictionaryKey: "REAChartsNode") as? String,
              let resources = Bundle.main.resourceURL,
              let request = try? JSONSerialization.data(withJSONObject: ["url": value]) else { return nil }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["--max-old-space-size=64", resources.appendingPathComponent("src/client.mjs").path, "receive"]
        process.standardInput = input; process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        input.fileHandleForWriting.write(request)
        try? input.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard data.count <= 1024 * 1024 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func applicationWillTerminate(_ notification: Notification) { restoreHandler() }
}

let app = NSApplication.shared
let delegate = LoginDelegate()
app.delegate = delegate
app.run()
