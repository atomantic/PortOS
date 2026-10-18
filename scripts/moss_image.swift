// PortOS CLI adapter for the pinned MIT-licensed moss-image-swift library.
// Compiled in its MossImageGate target; upstream code and LICENSE remain intact.
import CoreGraphics
import Foundation
import ImageIO
import Metal
import MLX
import MossImage
import UniformTypeIdentifiers

let adapterVersion = 1
let sourceRevision = "6c26a0296ba2d2a09e061d89a9b9b758786cd186"

func emit(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

func json(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func arguments() throws -> [String: String] {
    let args = Array(CommandLine.arguments.dropFirst())
    let allowed: Set<String> = ["--snapshot", "--prompt", "--negative", "--width", "--height", "--steps", "--guidance", "--seed", "--output"]
    guard args.count % 2 == 0 else { throw MossImageError.invalidInput("Every option needs a value") }
    var result: [String: String] = [:]
    for index in stride(from: 0, to: args.count, by: 2) {
        let key = args[index]
        guard allowed.contains(key), result[key] == nil else {
            throw MossImageError.invalidInput("Unknown or repeated option: \(key)")
        }
        result[key] = args[index + 1]
    }
    return result
}

func integer(_ args: [String: String], _ key: String, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
    guard let value = Int(args[key] ?? String(fallback)), range.contains(value) else {
        throw MossImageError.invalidInput("\(key) must be an integer in \(range)")
    }
    return value
}

func writePNG(_ image: MLXArray, to output: URL) throws {
    guard all(isFinite(image)).item(Bool.self) else {
        throw MossImageError.invalidInput("MOSS produced non-finite pixels")
    }
    let rgb = MossImagePipeline.toRGB8(image)
    let data = Data(rgb.pixels) as CFData
    guard let provider = CGDataProvider(data: data),
          let cgImage = CGImage(width: rgb.width, height: rgb.height, bitsPerComponent: 8,
              bitsPerPixel: 24, bytesPerRow: rgb.width * 3, space: CGColorSpace(name: CGColorSpace.sRGB)!,
              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider,
              decode: nil, shouldInterpolate: false, intent: .defaultIntent),
          let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw MossImageError.invalidInput("Cannot create output PNG") }
    CGImageDestinationAddImage(destination, cgImage, nil)
    guard CGImageDestinationFinalize(destination) else { throw MossImageError.invalidInput("Cannot write output PNG") }
}

func run() async throws {
    guard MTLCreateSystemDefaultDevice() != nil else { throw MossImageError.invalidInput("Metal GPU unavailable") }
    if CommandLine.arguments.dropFirst().elementsEqual(["--probe"]) {
        // Exercise the installed Metal resources, rather than accepting a binary that merely launches.
        guard sum(MLXArray([1, 2, 3])).item(Int.self) == 6 else {
            throw MossImageError.invalidInput("Metal tensor probe failed")
        }
        try json(["runtime": "moss-swift", "adapterVersion": adapterVersion,
                  "sourceRevision": sourceRevision, "metal": true])
        return
    }
    let args = try arguments()
    guard let snapshotPath = args["--snapshot"], let prompt = args["--prompt"], let outputPath = args["--output"] else {
        throw MossImageError.invalidInput("--snapshot, --prompt and --output are required")
    }
    var parameters = MossImageGenerationParameters()
    parameters.width = try integer(args, "--width", default: 1024, range: 256...1024)
    parameters.height = try integer(args, "--height", default: 1024, range: 256...1024)
    parameters.steps = try integer(args, "--steps", default: 50, range: 1...100)
    guard parameters.width % 16 == 0, parameters.height % 16 == 0 else {
        throw MossImageError.invalidInput("Dimensions must be multiples of 16")
    }
    guard let guidance = Float(args["--guidance"] ?? "3"), guidance.isFinite, (0...10).contains(guidance),
          let seed = UInt64(args["--seed"] ?? "42") else {
        throw MossImageError.invalidInput("Invalid guidance or seed")
    }
    parameters.guidanceScale = guidance
    parameters.seed = seed
    parameters.negativePrompt = args["--negative"] ?? ""
    guard guidance != 1 || parameters.negativePrompt.isEmpty else {
        throw MossImageError.invalidInput("A negative prompt requires guidance other than 1")
    }
    let snapshot = URL(fileURLWithPath: snapshotPath)
    emit("STAGE:validate-prompt")
    let tokenizer = try await MossImagePromptEncoder.loadTokenizer(snapshot: snapshot)
    for (label, text) in [("Prompt", prompt), ("Negative prompt", parameters.negativePrompt)] {
        let count = tokenizer.encode(text: MossImagePromptEncoder.render(text), addSpecialTokens: false).count
        guard count <= MossImagePromptEncoder.maxSequenceLength else {
            throw MossImageError.invalidInput("\(label) has \(count) tokens including the chat template; maximum is 4096. Shorten it before rendering.")
        }
    }
    emit("STAGE:loading-model")
    let pipeline = try await MossImagePipeline.load(transformerSnapshot: snapshot, dtype: .bfloat16)
    emit("STAGE:encode")
    let conditioning = try pipeline.encodeAndRelease(prompt: prompt, parameters: parameters)
    emit("STAGE:inference")
    let latents = try pipeline.denoise(conditioning: conditioning, parameters: parameters) { step, total, _ in
        emit("\((step + 1) * 100 / total)%| \(step + 1)/\(total)")
    }
    emit("STAGE:decode")
    try writePNG(pipeline.decode(latents), to: URL(fileURLWithPath: outputPath))
    try json(["output": outputPath, "peakMemoryBytes": Memory.peakMemory,
              "sourceRevision": sourceRevision, "adapterVersion": adapterVersion])
}

do {
    try await run()
} catch {
    emit("USER_ERROR:moss_image:\(error)")
    exit(1)
}
