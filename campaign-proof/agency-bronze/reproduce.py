import hashlib
import importlib.metadata
import json
import platform
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

from delta import configure_spark_with_delta_pip
from pyspark.sql import SparkSession

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "manifest.json").read_text())


def validate_source(raw, expected):
    if hashlib.sha256(raw).hexdigest() != expected["markdownSha256"]:
        raise ValueError("Markdown differs from the frozen original or approved patch")
    code = raw.decode().split("```python\n", 1)[1].split("\n```", 1)[0]
    if hashlib.sha256(code.encode()).hexdigest() != expected["completeCodeBlockSha256"]:
        raise ValueError("Complete documented block differs from its frozen source")
    return code


for name, expected in manifest["sources"].items():
    raw = (HERE / f"{name}.md").read_bytes()
    validate_source(raw, expected)
    try:
        validate_source(raw + b"\nchanged-source", expected)
        raise AssertionError("source guard accepted altered Markdown")
    except ValueError:
        pass


def qualified(evidence):
    try:
        before = evidence["sources"]["before"]["cases"]
        after = evidence["sources"]["after"]["cases"]
        return bool(evidence["runtimeControl"]
                    and (before["two_files"].get("errorClass") or "").startswith("UNRESOLVED_COLUMN")
                    and not before["two_files"]["output_exists"]
                    and not before["input_metadata_column"]["pass"]
                    and set(after) == {"two_files", "append", "empty_file", "input_metadata_column"}
                    and all(case["pass"] for case in after.values())
                    and after["two_files"]["returned"] == after["two_files"]["delta_rows"] == 2
                    and len(after["two_files"]["rows"]) == 2
                    and after["append"]["returned"] == 2 and after["append"]["delta_rows"] == 4
                    and after["empty_file"]["returned"] == after["empty_file"]["delta_rows"] == 0
                    and after["input_metadata_column"]["returned"] == after["input_metadata_column"]["delta_rows"] == 1)
    except (KeyError, TypeError):
        return False


# Evaluator faults are separate synthetic controls, never native pipeline evidence.
for faulty in ({}, {"runtimeControl": True, "sources": {}},
               {"runtimeControl": False, "sources": {"before": {}, "after": {}}}):
    assert not qualified(faulty)

builder = (SparkSession.builder.master("local[2]").appName("owned-bronze-provenance-proof")
           .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
           .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
           .config("spark.sql.shuffle.partitions", "2")
           .config("spark.databricks.delta.snapshotPartitions", "2")
           .config("spark.ui.enabled", "false"))
spark = configure_spark_with_delta_pip(builder).getOrCreate()
spark.sparkContext.setLogLevel("ERROR")
results = {"python": platform.python_version(), "pyspark": spark.version,
           "delta_spark": importlib.metadata.version("delta-spark"), "sources": {},
           "sourceManifest": manifest, "sourceGuardFaultsRejected": True}


def block(path):
    code = validate_source(path.read_bytes(), manifest["sources"][path.stem])
    namespace = {}
    exec(compile(code, str(path), "exec"), namespace)
    return namespace["ingest_bronze"], hashlib.sha256(code.encode()).hexdigest()


def native_case(ingest, source, target, expected):
    try:
        returned = ingest(str(source), str(target), "owned-fixture")
        rows = spark.read.format("delta").load(str(target)).collect()
        actual = sorted((row["id"], Path(unquote(urlparse(row["_source_file"]).path)).name,
                         row["_source_system"], row["_ingested_at"] is not None) for row in rows)
        passed = returned == len(expected) and actual == sorted((id_, file, "owned-fixture", True)
                                                                for id_, file in expected)
        return {"returned": returned, "delta_rows": len(rows), "rows": actual,
                "expected": expected, "pass": passed}
    except Exception as error:
        return {"pass": False, "errorType": type(error).__name__,
                "errorClass": error.getErrorClass() if hasattr(error, "getErrorClass") else None,
                "error": str(error)[:1800], "output_exists": target.exists()}


try:
    with tempfile.TemporaryDirectory(prefix="owned-bronze-proof-") as temporary:
        root = Path(temporary)
        # Native Delta write/read validates the runtime before source comparisons.
        environment = root / "runtime-control"
        spark.range(2).write.format("delta").save(str(environment))
        results["runtimeControl"] = spark.read.format("delta").load(str(environment)).count() == 2
        assert results["runtimeControl"]
        for name in ("before", "after"):
            ingest, digest = block(HERE / f"{name}.md")
            owned = root / name
            source = owned / "json"
            source.mkdir(parents=True)
            for id_, filename in ((1, "first.json"), (2, "second.json")):
                (source / filename).write_text(json.dumps({"id": id_, "value": f"row-{id_}"}) + "\n")
            target = owned / "bronze"
            expected = [(1, "first.json"), (2, "second.json")]
            cases = {"two_files": native_case(ingest, source, target, expected)}
            if cases["two_files"]["pass"]:
                # Append and complete native on-disk read; independent batch count stays two.
                returned = ingest(str(source), str(target), "owned-fixture")
                appended = spark.read.format("delta").load(str(target)).count()
                cases["append"] = {"returned": returned, "delta_rows": appended,
                                   "pass": returned == 2 and appended == 4}
            else:
                cases["append"] = {"pass": False, "notRun": "initial ingest did not succeed"}
            empty = owned / "empty.json"
            empty.write_text("")
            cases["empty_file"] = native_case(ingest, empty, owned / "empty-bronze", [])
            # Input columns named _metadata must not substitute for actual file provenance.
            spoofed = owned / "metadata.json"
            spoofed.write_text(json.dumps({"id": 3, "_metadata": {"file_path": "file:///made-up.json"}}) + "\n")
            cases["input_metadata_column"] = native_case(ingest, spoofed, owned / "metadata-bronze", [(3, "metadata.json")])
            results["sources"][name] = {"completeBlockSha256": digest, "cases": cases}
        results["qualified"] = qualified(results)
        if results["qualified"]:
            for path, replacement in (("two_files", {"pass": True, "returned": 0, "delta_rows": 0, "rows": []}),
                                      ("append", {"pass": False, "errorType": "NativeDeltaFailure"})):
                faulty = json.loads(json.dumps(results))
                faulty["sources"]["after"]["cases"][path] = replacement
                assert not qualified(faulty), "evaluator accepted zero rows or a native Delta failure"
            results["nativeResultFaultsRejected"] = True
finally:
    (HERE / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
    spark.stop()

assert results.get("qualified"), "native evidence did not qualify the proposed provenance correction"
