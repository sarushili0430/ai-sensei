import AVFAudio
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var decorativeAudioChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    decorativeAudioChannel = FlutterMethodChannel(
      name: "jp.co.aiSensei/decorative_audio",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    decorativeAudioChannel?.setMethodCallHandler { call, result in
      guard call.method == "prepare" else {
        result(FlutterMethodNotImplemented)
        return
      }

      do {
        let session = AVAudioSession.sharedInstance()
        // just_audio の既定(category=playback)は消音スイッチを迂回する。
        // 短い声かけは導線ではなく装飾なので ambient にし、消音の判断を
        // OSへ返す。音量は一切設定しない。授業ではこの直後に LiveKit が
        // マイクを公開し、会話用の category へ戻す順序を Dart 側が保証する。
        try session.setCategory(.ambient, mode: .default)
        try session.setActive(true)
        result(true)
      } catch {
        // 消音方針を準備できないときは、推測で鳴らすより無音へ倒す。
        result(false)
      }
    }
  }
}
