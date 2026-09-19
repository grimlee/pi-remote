import Foundation

public enum ControlRequestCrypto {
    public static func sessionsListMessage(
        requestId: String,
        machineId: String,
        deviceId: String,
        issuedAtMs: Int64
    ) -> Data {
        var message = baseMessage(
            requestId: requestId,
            machineId: machineId,
            deviceId: deviceId,
            issuedAtMs: issuedAtMs,
            operation: "sessions.list"
        )
        return message
    }

    public static func sessionsLinkMessage(
        requestId: String,
        machineId: String,
        deviceId: String,
        issuedAtMs: Int64,
        instanceId: String,
        generation: Int,
        access: String,
        resumeFromHostSeq: Int64? = nil
    ) -> Data {
        var message = baseMessage(
            requestId: requestId,
            machineId: machineId,
            deviceId: deviceId,
            issuedAtMs: issuedAtMs,
            operation: "sessions.link"
        )
        append(instanceId, to: &message)
        append(String(generation), to: &message)
        message.append(Data(access.utf8))
        if let resumeFromHostSeq {
            message.append(0)
            message.append(
                Data(String(resumeFromHostSeq).utf8)
            )
        }
        return message
    }

    private static func baseMessage(
        requestId: String,
        machineId: String,
        deviceId: String,
        issuedAtMs: Int64,
        operation: String
    ) -> Data {
        var message = Data("piremote-control-request-v1\0".utf8)
        append(requestId, to: &message)
        append(machineId, to: &message)
        append(deviceId, to: &message)
        append(String(issuedAtMs), to: &message)
        message.append(Data(operation.utf8))
        if operation == "sessions.link" {
            message.append(0)
        }
        return message
    }

    private static func append(_ value: String, to data: inout Data) {
        data.append(Data(value.utf8))
        data.append(0)
    }
}
