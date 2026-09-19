@preconcurrency import AVFoundation
import SwiftUI
import UIKit

struct QRCodeScannerView: UIViewControllerRepresentable {
    let onCode: @MainActor (String) -> Void
    let onError: @MainActor (String) -> Void

    func makeUIViewController(
        context: Context
    ) -> QRCodeScannerViewController {
        QRCodeScannerViewController(
            onCode: onCode,
            onError: onError
        )
    }

    func updateUIViewController(
        _ uiViewController: QRCodeScannerViewController,
        context: Context
    ) {}
}

@MainActor
final class QRCodeScannerViewController:
    UIViewController,
    AVCaptureMetadataOutputObjectsDelegate
{
    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var configured = false
    private var deliveredCode = false

    private let onCode: @MainActor (String) -> Void
    private let onError: @MainActor (String) -> Void

    init(
        onCode: @escaping @MainActor (String) -> Void,
        onError: @escaping @MainActor (String) -> Void
    ) {
        self.onCode = onCode
        self.onError = onError
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        prepareCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if captureSession.isRunning {
            captureSession.stopRunning()
        }
    }

    private func prepareCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureAndStart()

        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted {
                        self.configureAndStart()
                    } else {
                        self.onError(
                            "Camera access is required to scan a Pi Remote pairing QR code."
                        )
                    }
                }
            }

        case .denied, .restricted:
            onError(
                "Camera access is required to scan a Pi Remote pairing QR code."
            )

        @unknown default:
            onError("Camera access is unavailable.")
        }
    }

    private func configureAndStart() {
        guard !configured else {
            if !captureSession.isRunning {
                captureSession.startRunning()
            }
            return
        }

        guard let camera = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: .back
        ) else {
            onError("No rear camera is available.")
            return
        }

        do {
            let input = try AVCaptureDeviceInput(device: camera)
            guard captureSession.canAddInput(input) else {
                onError("The camera could not be attached to the scanner.")
                return
            }
            captureSession.addInput(input)
        } catch {
            onError("The camera could not be opened.")
            return
        }

        let output = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(output) else {
            onError("QR scanning is not supported on this device.")
            return
        }

        captureSession.addOutput(output)
        output.setMetadataObjectsDelegate(
            self,
            queue: .main
        )
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(
            session: captureSession
        )
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview

        configured = true
        captureSession.startRunning()
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !deliveredCode else { return }

        for object in metadataObjects {
            guard let qr = object as? AVMetadataMachineReadableCodeObject,
                  qr.type == .qr,
                  let value = qr.stringValue?
                    .trimmingCharacters(
                        in: .whitespacesAndNewlines
                    ),
                  value.hasPrefix("piremote-pair-v1.")
            else {
                continue
            }

            deliveredCode = true
            captureSession.stopRunning()
            onCode(value)
            return
        }
    }
}
