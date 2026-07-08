from pathlib import Path
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor

BASE = Path(__file__).resolve().parent
DATA = pd.read_csv(BASE / "jnpa_ai_training_dataset_2022_2026.csv")

targets = [
    "vessel_turnaround_hr",
    "cargo_dwell_hr",
    "yard_utilization_pct",
    "pre_berthing_delay_hr",
    "resource_optimization_pct",
]

features = [
    "year", "month", "quarter", "terminal", "flow_type",
    "container_count_on_vessel", "berth_hours", "crane_moves_per_hour",
    "customs_ooc_available", "seasonality_scale"
]

results = {}
for target in targets:
    X = pd.get_dummies(DATA[features], drop_first=False)
    y = DATA[target]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = XGBRegressor(
        n_estimators=240,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        objective="reg:squarederror",
        random_state=42,
        n_jobs=4,
    )
    model.fit(X_train, y_train)
    pred = model.predict(X_test)
    results[target] = {
        "mae": float(mean_absolute_error(y_test, pred)),
        "rmse": float(mean_squared_error(y_test, pred) ** 0.5),
        "r2": float(r2_score(y_test, pred)),
    }
    model.save_model(str(BASE / f"{target}.json"))

print(results)
