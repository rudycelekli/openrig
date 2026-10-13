"""Run full documented Model QA blocks with real estimators and real SHAP plots."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile

import numpy as np
import pandas as pd
import shap
import matplotlib.pyplot as plt
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LinearRegression, LogisticRegression

source = Path(sys.argv[1]).resolve()
raw = source.read_text()
blocks = re.findall(r"```python\n(.*?)\n```", raw, re.S)
namespace = {}
for index, block in enumerate(blocks):
    exec(compile(block, str(source) + f"#block-{index}", "exec"), namespace)

X = pd.DataFrame(np.random.default_rng(42).normal(size=(12, 2)), columns=["alpha", "beta"])
y_reg = 2 * X.alpha - X.beta + 0.3
y_class = (X.alpha > 0).astype(int)
models = {
    "linear_kernel": LinearRegression().fit(X, y_reg),
    "logistic_kernel": LogisticRegression().fit(X, y_class),
    "forest_classifier_control": RandomForestClassifier(n_estimators=5, max_depth=2, random_state=42).fit(X, y_class),
    "forest_regressor_control": RandomForestRegressor(n_estimators=5, max_depth=2, random_state=42).fit(X, y_reg),
}
cases = []
real_waterfall = shap.plots.waterfall
observed_explanations = []


def observe_real_waterfall(explanation, *args, **kwargs):
    observed_explanations.append(explanation)
    return real_waterfall(explanation, *args, **kwargs)


shap.plots.waterfall = observe_real_waterfall
try:
    with tempfile.TemporaryDirectory(prefix="owned-native-shap-") as temporary:
        root = Path(temporary)
        prior_cwd = Path.cwd()
        try:
            for label, model in models.items():
                owned = root / label
                owned.mkdir()
                os.chdir(owned)
                for action in ("global", "local"):
                    observed_explanations.clear()
                    try:
                        if action == "global":
                            ranking = namespace["shap_global_analysis"](model, X, str(owned))
                            passed = set(ranking.feature) == set(X.columns) and np.isfinite(ranking.mean_abs_shap).all()
                            numerical = ranking.to_dict("records")
                            expected_files = ["shap_beeswarm.png", "shap_importance.png"]
                        else:
                            namespace["shap_local_explanation"](model, X, 0)
                            assert len(observed_explanations) == 1
                            explanation = observed_explanations[0]
                            actual = float(explanation.base_values + explanation.values.sum())
                            expected = float(model.predict_proba(X.iloc[[0]])[0, 1]) if hasattr(model, "predict_proba") else float(model.predict(X.iloc[[0]])[0])
                            passed = bool(np.isclose(actual, expected, rtol=1e-5, atol=1e-6)
                                          and explanation.values.shape == (len(X.columns),))
                            numerical = {"base_plus_contributions": actual, "native_model_prediction": expected}
                            expected_files = ["shap_waterfall_obs_0.png"]
                        plots = {name: {"bytes": (owned / name).stat().st_size,
                                        "png": (owned / name).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")}
                                 for name in expected_files}
                        passed = bool(passed and all(record["png"] and record["bytes"] > 1000 for record in plots.values()))
                        cases.append({"case": label + "_" + action, "pass": passed, "numerical": numerical, "plots": plots})
                    except Exception as error:
                        cases.append({"case": label + "_" + action, "pass": False,
                                      "errorType": type(error).__name__, "error": str(error)})
                    finally:
                        plt.close("all")
        finally:
            os.chdir(prior_cwd)
finally:
    shap.plots.waterfall = real_waterfall

receipt = {"sourceSha256": hashlib.sha256(raw.encode()).hexdigest(),
           "executedBlockSha256": [hashlib.sha256(block.encode()).hexdigest() for block in blocks],
           "versions": {package: importlib.metadata.version(package)
                        for package in ("shap", "numpy", "pandas", "scikit-learn", "numba", "scipy", "matplotlib")},
           "scope": "all literal Python blocks loaded unchanged; real fitted estimator, SHAP computation and plot renderer; only waterfall argument observed while original renderer still called",
           "cases": cases, "passed": sum(case["pass"] for case in cases), "failed": sum(not case["pass"] for case in cases)}
print(json.dumps(receipt, indent=2))
raise SystemExit(bool(receipt["failed"]))
