#!/usr/bin/env python3
"""Run inference on a model and report timing information.

Supports ONNX, scikit-learn joblib, Keras image models and YOLO.
The script can be used as a CLI or imported as a module to load
models and run predictions directly in Python.
"""
import argparse
import os
import sys
import subprocess
import time

DEFAULT_VENV = os.path.expanduser(os.environ.get("ONNX_ENV", "~/onnx-env"))

REQUIRED_PACKAGES = [
    "joblib",
    "numpy",
    "onnxruntime",
    "transformers",
    "tensorflow",
    "keras",
    "websockets",
    "Pillow",
    "psutil",
    "gputil",
    "ultralytics",
]


def ensure_venv(path=DEFAULT_VENV):
    """Create and activate a virtual environment if needed and install packages."""
    path = os.path.abspath(os.path.expanduser(path))
    if os.path.abspath(sys.prefix) == path:
        return
    first_setup = False
    if not os.path.isdir(path):
        print(f"Creating virtual environment in {path}...")
        subprocess.check_call(["python3", "-m", "venv", path])
        first_setup = True
    python = os.path.join(path, "bin", "python")
    if not os.path.exists(python):
        python = os.path.join(path, "Scripts", "python.exe")
    if first_setup:
        print("Installing dependencies in the virtual environment...")
        subprocess.check_call([python, "-m", "pip", "install", "--upgrade", "pip"])
        subprocess.check_call([python, "-m", "pip", "install", *REQUIRED_PACKAGES])
    print("Activating virtual environment...")
    os.execv(python, [python] + sys.argv)


def load_joblib(path):
    import joblib
    model = joblib.load(path)

    def predict(sample):
        try:
            feats = [float(x) for x in sample.split(',') if x.strip()]
            pred = model.predict([feats])[0]
            proba = None
            if hasattr(model, "predict_proba"):
                proba = float(max(model.predict_proba([feats])[0]))
            return pred, proba
        except ValueError:
            pred = model.predict([sample])[0]
            proba = None
            if hasattr(model, "predict_proba"):
                proba = float(max(model.predict_proba([sample])[0]))
            return pred, proba

    return predict


def load_onnx(path):
    """Load an ONNX model for text, numeric or image classification."""
    try:
        import onnxruntime as ort
    except ImportError as e:
        raise SystemExit(
            "onnxruntime is required. Install it in your virtual environment with:\n"
            f"  {sys.executable} -m pip install onnxruntime"
        ) from e
    from transformers import AutoTokenizer, AutoConfig
    import numpy as np
    import base64
    import io
    from PIL import Image

    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    input_info = session.get_inputs()[0]
    input_name = input_info.name
    is_image = len(input_info.shape) == 4

    base = path[:-5]
    if base.endswith("_quant"):
        base = base[:-6]
    tokenizer = None
    config = None
    model_dir = base if os.path.isdir(base) else os.path.join(os.path.dirname(path), "model")
    if os.path.isdir(model_dir) and not is_image:
        tokenizer = AutoTokenizer.from_pretrained(model_dir)
        config = AutoConfig.from_pretrained(model_dir)

    def predict(sample):
        if is_image:
            if isinstance(sample, str):
                img_bytes = base64.b64decode(sample)
                img = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((128, 128))
                arr = np.array(img, dtype=np.float32) / 255.0
            else:
                arr = sample
            arr = np.expand_dims(arr, 0).astype(np.float32)
            preds = session.run(None, {input_name: arr})[0][0]
            idx = int(np.argmax(preds))
            proba = float(preds[idx])
            return idx, proba
        if tokenizer:
            inputs = tokenizer(sample, return_tensors="np")
            ort_inputs = {k: v.astype(np.int64) for k, v in inputs.items()}
            outputs = session.run(None, ort_inputs)[0]
            idx = int(np.argmax(outputs, axis=1)[0])
            label = config.id2label.get(idx, str(idx))
            proba = float(np.exp(outputs[0][idx]) / np.exp(outputs[0]).sum())
            return label, proba

        if input_info.type.startswith("tensor(string"):
            arr = np.array([sample])
            pred = session.run(None, {input_name: arr})[0]
            if isinstance(pred, list):
                pred = pred[0]
            pred_val = pred[0] if hasattr(pred, "__getitem__") else pred
            return pred_val, None

        try:
            feats = np.array([[float(x) for x in sample.split(',') if x.strip()]], dtype=np.float32)
        except ValueError as e:
            raise ValueError(
                "Model expects numeric features (comma separated). "
                "If this is a text model, make sure the tokenizer "
                "directory is present next to the ONNX file."
            ) from e
        outs = session.run(None, {input_name: feats})
        pred = outs[0][0]
        proba = None
        if len(outs) > 1:
            try:
                proba = float(outs[1][0][int(pred)])
            except Exception:
                pass
        return pred, proba

    return predict


def load_keras_image(path):
    """Load a .keras image model using Keras or TensorFlow."""
    import base64
    import io
    from PIL import Image
    import numpy as np
    import os

    try:
        import keras
        model = keras.saving.load_model(path)
    except Exception:
        import tensorflow as tf
        model = tf.keras.models.load_model(path)

    def predict(img_b64):
        if isinstance(img_b64, str):
            img_bytes = base64.b64decode(img_b64)
            img = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((128, 128))
            arr = tf.keras.preprocessing.image.img_to_array(img) / 255.0
        else:
            arr = img_b64
        arr = tf.expand_dims(arr, 0)
        preds = model.predict(arr)[0]
        idx = int(np.argmax(preds))
        proba = float(preds[idx])
        return idx, proba

    return predict


def load_yolo(path):
    """Load a YOLO object detection model using Ultralytics."""
    import base64
    from io import BytesIO
    from PIL import Image
    from ultralytics import YOLO

    model = YOLO(path)

    def predict(img_b64):
        if isinstance(img_b64, str):
            img_bytes = base64.b64decode(img_b64)
            img = Image.open(BytesIO(img_bytes)).convert("RGB")
        else:
            img = Image.fromarray(img_b64)
        results = model.predict(img, verbose=False)
        det = results[0]
        classes = [int(c) for c in det.boxes.cls.tolist()]
        names = [det.names[c] for c in classes]
        return {
            "boxes": det.boxes.xyxy.tolist(),
            "scores": det.boxes.conf.tolist(),
            "classes": classes,
            "names": names,
        }, None

    return predict


def load_model(path, model_type="auto"):
    """Return a prediction function for the given model."""
    if model_type == "yolo":
        return load_yolo(path)
    if model_type == "image":
        if path.endswith(".onnx"):
            return load_onnx(path)
        return load_keras_image(path)
    if model_type == "text":
        if path.endswith(".onnx"):
            return load_onnx(path)
        return load_joblib(path)
    if path.endswith(".joblib"):
        return load_joblib(path)
    if path.endswith(".pt"):
        return load_yolo(path)
    if path.endswith(".onnx") and (os.path.basename(path).startswith("yolov5") or os.path.basename(path).startswith("yolov8")):
        return load_yolo(path)
    if path.endswith(".onnx"):
        return load_onnx(path)
    if path.endswith(".keras"):
        return load_keras_image(path)
    raise ValueError("Only .joblib, .onnx, .keras or .pt models are supported")


def predict_sample(model, sample, runs=1, model_type="auto", venv=DEFAULT_VENV):
    """Load a model and run prediction, returning (result, proba)."""
    ensure_venv(venv)
    predict = load_model(model, model_type)
    result, proba = predict(sample)
    for _ in range(runs - 1):
        result, proba = predict(sample)
    return result, proba


def main():
    parser = argparse.ArgumentParser(description="Test a trained model on Raspberry Pi.")
    parser.add_argument("model", help="Path to a model file (.onnx, .joblib, .keras or .pt)")
    parser.add_argument("sample", help="Text, comma separated features or base64 image")
    parser.add_argument("--runs", type=int, default=5, help="Number of runs for averaging")
    parser.add_argument("--venv", default=DEFAULT_VENV, help="Path to the virtual environment")
    parser.add_argument("--type", choices=["auto", "yolo", "image", "text"], default="auto", help="Force the model type instead of guessing")
    args = parser.parse_args()

    ensure_venv(args.venv)
    predict = load_model(args.model, args.type)
    result, proba = predict(args.sample)
    times = []
    for _ in range(args.runs):
        start = time.perf_counter()
        result, proba = predict(args.sample)
        times.append(time.perf_counter() - start)
    avg = sum(times) / len(times)
    print(f"Prediction: {result}")
    if proba is not None:
        print(f"Score: {proba:.4f}")
    print(f"Average time over {args.runs} runs: {avg:.4f}s")


if __name__ == "__main__":
    main()
