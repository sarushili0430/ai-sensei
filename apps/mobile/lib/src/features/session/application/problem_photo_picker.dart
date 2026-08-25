import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

/// 会話中に追加する問題写真の取得口。
///
/// 画面からプラグインを直接呼ぶと、カメラを開くテストが端末依存になる。
/// 取得だけを差し替え可能にし、アップロード以降は [SessionController] が持つ。
///
/// **いま画面から呼ぶ場所は無い**(2026-08-25。ADR 0009 の追記)。授業中の
/// 「問題を追加」を板書の上から外したので、この口を叩く枚が消えた。**消さずに
/// 残してあるのは、解析とagent通知の経路(`SessionController.addProblemPhoto` /
/// `session-control.ts` の `context_updated`)がそのまま生きているから** —
/// 戻すときに要るのは画面の口1つで、ここから下は書き直さなくていい。
abstract interface class ProblemPhotoPicker {
  Future<File?> takePhoto();
}

class DeviceProblemPhotoPicker implements ProblemPhotoPicker {
  DeviceProblemPhotoPicker({ImagePicker? picker})
    : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  @override
  Future<File?> takePhoto() async {
    final XFile? picked = await _picker.pickImage(
      source: ImageSource.camera,
      imageQuality: 85,
      // Visionが解像度として使える長辺2576pxまでは残し、それ以上だけを送信前に落とす。
      maxWidth: 2576,
      maxHeight: 2576,
      // EXIFは使わない。iOSで余分な写真アクセス許可を要求しないため取得しない。
      requestFullMetadata: false,
    );
    return picked == null ? null : File(picked.path);
  }
}

final Provider<ProblemPhotoPicker> problemPhotoPickerProvider =
    Provider<ProblemPhotoPicker>((_) => DeviceProblemPhotoPicker());
