import Foundation
import Darwin

enum Refusal: String, Error {
    case missing, notCurrent, conflicted, revisionChanged, unsafePath, unavailable, uncertain
}

func checkedURL(_ url: URL, ubiquity: Bool) throws {
    var info = stat()
    guard lstat(url.path, &info) == 0 else {
        throw errno == ENOENT ? Refusal.missing : Refusal.unavailable
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else { throw Refusal.unsafePath }
    guard ubiquity else { return }
    var original = url
    original.removeAllCachedResourceValues()
    let values = try original.resourceValues(forKeys: [
        .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey,
        .ubiquitousItemIsUploadingKey, .ubiquitousItemHasUnresolvedConflictsKey
    ])
    if values.ubiquitousItemHasUnresolvedConflicts == true
        || !(NSFileVersion.unresolvedConflictVersionsOfItem(at: original) ?? []).isEmpty {
        throw Refusal.conflicted
    }
    guard values.isUbiquitousItem == true,
          values.ubiquitousItemDownloadingStatus == .current,
          values.ubiquitousItemIsUploading != true else { throw Refusal.notCurrent }
}

// NSFileCoordinator arbitrates access with cooperating processes on this Mac.
// It does not provide cross-device iCloud transactions. The exact preimage
// comparison is intentionally inside the coordinator's exclusive access block.
func commit(_ target: URL, expected: Data, candidate: Data, ubiquity: Bool) throws {
    var coordinationError: NSError?
    var operationError: Error?
    var beganReplacement = false
    let coordinator = NSFileCoordinator()
    coordinator.coordinate(writingItemAt: target, options: .forReplacing, error: &coordinationError) { url in
        do {
            try checkedURL(url, ubiquity: ubiquity)
            guard try Data(contentsOf: url) == expected else { throw Refusal.revisionChanged }
            beganReplacement = true
            try candidate.write(to: url, options: .atomic)
            guard try Data(contentsOf: url) == candidate else { throw Refusal.uncertain }
        } catch {
            operationError = beganReplacement ? Refusal.uncertain : error
        }
    }
    if let error = operationError { throw error }
    if coordinationError != nil { throw beganReplacement ? Refusal.uncertain : Refusal.unavailable }
}

umask(0o077) // Newly replaced private health files must not become world-readable.

do {
    let args = CommandLine.arguments
    guard args.count == 6, ["inspect", "commit"].contains(args[1]) else { throw Refusal.unavailable }
    let target = URL(fileURLWithPath: args[2])
    let ubiquity = args[3] == "icloud"
    if args[1] == "inspect" {
        try checkedURL(target, ubiquity: ubiquity)
    } else {
        try commit(target, expected: Data(contentsOf: URL(fileURLWithPath: args[4])),
                   candidate: Data(contentsOf: URL(fileURLWithPath: args[5])), ubiquity: ubiquity)
    }
    print("ok")
} catch let error as Refusal {
    print(error.rawValue)
} catch {
    // No filesystem paths, record data, or environment details on stdout.
    print(Refusal.unavailable.rawValue)
}
