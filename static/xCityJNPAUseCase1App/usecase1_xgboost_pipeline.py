from __future__ import annotations
import json
from pathlib import Path
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, accuracy_score, precision_score, recall_score, f1_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from xgboost import XGBRegressor, XGBClassifier

DATA_PATH = Path("usecase1_vessel_berth_hypothetical_5400rows.csv")
OUTPUT_DIR = Path("model_outputs")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

TARGETS_REG = ["eta_deviation_min","pre_berthing_delay_min","service_time_min","vessel_turnaround_min","berth_pressure_index"]
TARGET_CLF = "berth_conflict_flag"
DROP_COLS = ["vessel_id","vessel_name","planned_eta","actual_arrival","berth_start","ops_commenced","ops_completed","sailed_time"]

NUMERIC_FEATURES = [
    "hour_of_day","day_of_week","month","weekend_flag","peak_hour_flag",
    "loa_m","draft_m","import_moves","export_moves","total_moves",
    "weather_risk_index","tide_window_flag","channel_congestion_index",
    "berth_length_m","berth_depth_m","berth_utilization_last_6h","berth_utilization_last_24h",
    "previous_vessel_completion_gap_min","berth_productivity_moves_per_hr",
    "pilot_available_flag","tug_available_flag","crane_allocation_count",
    "yard_congestion_index","gate_congestion_index","truck_evacuation_readiness_index"
]
CATEGORICAL_FEATURES = ["shipping_line","service_string","vessel_type","terminal_code","candidate_berth"]

def build_preprocessor():
    num_pipe = Pipeline(steps=[("imputer", SimpleImputer(strategy="median"))])
    cat_pipe = Pipeline(steps=[("imputer", SimpleImputer(strategy="most_frequent")),("onehot", OneHotEncoder(handle_unknown="ignore"))])
    return ColumnTransformer([("num", num_pipe, NUMERIC_FEATURES),("cat", cat_pipe, CATEGORICAL_FEATURES)])

def reg_pipe():
    return Pipeline(steps=[
        ("preprocess", build_preprocessor()),
        ("model", XGBRegressor(n_estimators=300,max_depth=6,learning_rate=0.05,subsample=0.9,colsample_bytree=0.9,objective="reg:squarederror",random_state=42,n_jobs=4))
    ])

def clf_pipe():
    return Pipeline(steps=[
        ("preprocess", build_preprocessor()),
        ("model", XGBClassifier(n_estimators=250,max_depth=6,learning_rate=0.05,subsample=0.9,colsample_bytree=0.9,objective="binary:logistic",eval_metric="logloss",random_state=42,n_jobs=4))
    ])

def rmse(y_true, y_pred):
    return mean_squared_error(y_true, y_pred) ** 0.5

def main():
    df = pd.read_csv(DATA_PATH)
    X = df.drop(columns=[*DROP_COLS, *TARGETS_REG, TARGET_CLF], errors="ignore")
    results = {}

    for target in TARGETS_REG:
        X_train, X_test, y_train, y_test = train_test_split(X, df[target], test_size=0.2, random_state=42)
        pipe = reg_pipe()
        pipe.fit(X_train, y_train)
        preds = pipe.predict(X_test)
        results[target] = {
            "type": "regression",
            "mae": float(mean_absolute_error(y_test, preds)),
            "rmse": float(rmse(y_test, preds)),
            "r2": float(r2_score(y_test, preds)),
        }
        pd.DataFrame({"actual": y_test, "predicted": preds}).head(300).to_csv(OUTPUT_DIR / f"{target}_predictions_sample.csv", index=False)

    X_train, X_test, y_train, y_test = train_test_split(X, df[TARGET_CLF], test_size=0.2, random_state=42, stratify=df[TARGET_CLF])
    pipe = clf_pipe()
    pipe.fit(X_train, y_train)
    prob = pipe.predict_proba(X_test)[:, 1]
    pred = (prob >= 0.5).astype(int)
    results[TARGET_CLF] = {
        "type": "classification",
        "accuracy": float(accuracy_score(y_test, pred)),
        "precision": float(precision_score(y_test, pred, zero_division=0)),
        "recall": float(recall_score(y_test, pred, zero_division=0)),
        "f1": float(f1_score(y_test, pred, zero_division=0)),
        "roc_auc": float(roc_auc_score(y_test, prob)),
    }
    pd.DataFrame({"actual": y_test, "predicted": pred, "probability": prob}).head(300).to_csv(OUTPUT_DIR / f"{TARGET_CLF}_predictions_sample.csv", index=False)

    baseline = {
        "avg_eta_deviation_min": 48,
        "avg_pre_berthing_delay_min": 110,
        "avg_service_time_min": 780,
        "avg_vessel_turnaround_min": 1020,
        "avg_berth_pressure_index": 1.15,
        "berth_conflict_rate_pct": 28
    }
    current = {
        "avg_eta_deviation_min": float(df["eta_deviation_min"].mean()),
        "avg_pre_berthing_delay_min": float(df["pre_berthing_delay_min"].mean()),
        "avg_service_time_min": float(df["service_time_min"].mean()),
        "avg_vessel_turnaround_min": float(df["vessel_turnaround_min"].mean()),
        "avg_berth_pressure_index": float(df["berth_pressure_index"].mean()),
        "berth_conflict_rate_pct": float(df["berth_conflict_flag"].mean() * 100)
    }
    payload = {
        "tabs": ["Executive Summary","Vessel Arrival & ETA","Berth Pressure & Conflict Risk","Service Time & Turnaround","What-If Scenario Lab","AI Recommendations"],
        "baseline": baseline,
        "current": current,
        "model_metrics": results,
        "recommendations": [
            "Increase berth-window coordination during peak arrival clusters.",
            "Use conflict-risk scores to pre-rank alternate feasible berths.",
            "Improve crane allocation and downstream evacuation readiness.",
            "Protect high-move mainline vessels in constrained tide windows."
        ]
    }
    with open(OUTPUT_DIR / "usecase1_dashboard_payload.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(json.dumps(payload, indent=2))

    # --- ADD THIS NEW BLOCK ---
    
    # 1. Retrain models on the FULL dataset and predict for all 5400 rows
    final_df = df.copy()
    
    for target in TARGETS_REG:
        pipe = reg_pipe()
        pipe.fit(X, df[target])
        final_df[f"{target}_predicted"] = pipe.predict(X)
        
    clf = clf_pipe()
    clf.fit(X, df[TARGET_CLF])
    final_df[f"{TARGET_CLF}_predicted"] = clf.predict(X)
    
    # 2. Export the full DataFrame with predictions to JSON for your dashboard
    final_df.to_json(OUTPUT_DIR / 'usecase1_predictions.json', orient='records')

if __name__ == "__main__":
    main()