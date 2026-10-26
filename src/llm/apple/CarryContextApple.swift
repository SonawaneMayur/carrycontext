// CarryContext's helper for Apple's on-device model (the Foundation Models framework).
//
// Protocol: one JSON request on stdin, one JSON response on stdout.
//   --status   -> {"ok":true,"available":true,"contextSize":4096}
//                 {"ok":true,"available":false,"reason":"appleIntelligenceNotEnabled"}
//   request    -> {"system":"…","prompt":"…","maxTokens":900,"temperature":0.2,"schema":{…}}
//   response   -> {"ok":true,"text":"…"}, or {"ok":true,"json":"{…}"} when a schema was given
//   error      -> {"ok":false,"error":"context","tokens":4090,"limit":4096}
//
// The helper never writes files, never opens network connections, and never puts prompt text
// in an error. CarryContext runs it inside a macOS sandbox that blocks network access, file
// writes and reads of the home folder, with an empty environment (see src/llm/apple.js).
import Foundation
import FoundationModels

struct Request: Decodable {
  let system: String?
  let prompt: String
  let maxTokens: Int?
  let temperature: Double?
  let schema: Schema?
}

/// The shape of a structured answer: a small subset of JSON Schema.
final class Schema: Decodable {
  let type: String
  let description: String?
  let properties: [String: Schema]?
  let required: [String]?
  let items: Schema?
  let `enum`: [String]?
}

struct BadSchema: Error {}

/// Build Apple's runtime schema from our JSON description. Runtime schemas need no Swift
/// macros, so the helper builds with the Command Line Tools alone (no full Xcode).
func dynamicSchema(_ s: Schema, name: String) throws -> DynamicGenerationSchema {
  switch s.type {
  case "object":
    let required = Set(s.required ?? [])
    let properties = try (s.properties ?? [:]).sorted { $0.key < $1.key }.map { key, value in
      DynamicGenerationSchema.Property(
        name: key,
        description: value.description,
        schema: try dynamicSchema(value, name: "\(name)_\(key)"),
        isOptional: !required.contains(key)
      )
    }
    return DynamicGenerationSchema(name: name, description: s.description, properties: properties)
  case "array":
    guard let items = s.items else { throw BadSchema() }
    return DynamicGenerationSchema(arrayOf: try dynamicSchema(items, name: "\(name)_item"))
  case "string":
    if let choices = s.enum, !choices.isEmpty {
      return DynamicGenerationSchema(name: name, description: s.description, anyOf: choices)
    }
    return DynamicGenerationSchema(type: String.self)
  case "number": return DynamicGenerationSchema(type: Double.self)
  case "integer": return DynamicGenerationSchema(type: Int.self)
  case "boolean": return DynamicGenerationSchema(type: Bool.self)
  default: throw BadSchema()
  }
}

func emit(_ fields: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: fields), let text = String(data: data, encoding: .utf8) {
    print(text)
  }
}

func fail(_ code: String, _ extra: [String: Any] = [:]) {
  emit(["ok": false, "error": code].merging(extra) { a, _ in a })
  exit(1)
}

func reasonCode(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
  switch reason {
  case .deviceNotEligible: return "deviceNotEligible"
  case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
  case .modelNotReady: return "modelNotReady"
  @unknown default: return "unavailable"
  }
}

/// Integers in a framework message ("Content contains 4090 tokens … context size of 4096"),
/// so only numbers, never text, are passed on.
func integers(in text: String) -> [Int] {
  text.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
}

@main
struct CarryContextApple {
  static func main() async {
    // Summarizing and extracting from the user's own text is a content transformation.
    let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)

    if CommandLine.arguments.contains("--status") {
      switch model.availability {
      case .available: emit(["ok": true, "available": true, "contextSize": model.contextSize])
      case .unavailable(let reason): emit(["ok": true, "available": false, "reason": reasonCode(reason)])
      }
      return
    }

    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 4_000_000, let request = try? JSONDecoder().decode(Request.self, from: input) else {
      return fail("bad-request")
    }
    if case .unavailable(let reason) = model.availability {
      return fail("unavailable", ["reason": reasonCode(reason)])
    }

    let session = LanguageModelSession(model: model, instructions: request.system ?? "")
    let options = GenerationOptions(temperature: request.temperature, maximumResponseTokens: request.maxTokens)
    do {
      if let schema = request.schema {
        let generation = try GenerationSchema(root: try dynamicSchema(schema, name: "Answer"), dependencies: [])
        let response = try await session.respond(to: request.prompt, schema: generation, options: options)
        emit(["ok": true, "json": response.content.jsonString])
      } else {
        let response = try await session.respond(to: request.prompt, options: options)
        emit(["ok": true, "text": response.content])
      }
    } catch let error as LanguageModelSession.GenerationError {
      switch error {
      case .exceededContextWindowSize(let context):
        let n = integers(in: context.debugDescription)
        fail("context", n.count >= 2 ? ["tokens": n[0], "limit": n[n.count - 1]] : [:])
      case .guardrailViolation: fail("guardrail")
      case .unsupportedLanguageOrLocale: fail("unsupported-language")
      case .assetsUnavailable: fail("unavailable")
      case .rateLimited: fail("rate-limited")
      case .concurrentRequests: fail("busy")
      default: fail("failed")
      }
    } catch is BadSchema {
      fail("bad-schema")
    } catch {
      fail("failed")
    }
  }
}
