import Foundation
import PiRemoteCore

struct PiModelOption: Identifiable, Hashable, Sendable {
    let provider: String
    let modelId: String
    let name: String
    let reasoning: Bool

    var id: String {
        provider + "/" + modelId
    }

    var displayName: String {
        name.isEmpty ? modelId : name
    }

    static func parse(_ value: JSONValue) -> PiModelOption? {
        guard let object = value.objectValue,
              let provider = object["provider"]?.stringValue,
              let modelId = object["id"]?.stringValue
        else {
            return nil
        }

        return PiModelOption(
            provider: provider,
            modelId: modelId,
            name: object["name"]?.stringValue ?? modelId,
            reasoning: object["reasoning"]?.boolValue ?? false
        )
    }
}
