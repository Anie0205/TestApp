import pandas as pd
from pathlib import Path
from xgboost import XGBRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score

def main():
    data_path = Path("jnpa_ai_historical_5year_package/ml/jnpa_ai_training_dataset_2022_2026.csv")
    if not data_path.exists():
        print(f"ERROR: Cannot find {data_path}")
        return
        
    df = pd.read_csv(data_path)

    features = ["year", "month", "quarter", "terminal", "flow_type", 
                "container_count_on_vessel", "berth_hours", "crane_moves_per_hour", 
                "customs_ooc_available", "seasonality_scale"]
    
    print("Preparing data and extracting features...")
    X = pd.get_dummies(df[features])
    
    # 1. NEW: Split the data so we can test the model on "unseen" data
    X_train, X_test, y_train_turnaround, y_test_turnaround = train_test_split(X, df["vessel_turnaround_hr"], test_size=0.2, random_state=42)
    _, _, y_train_delay, y_test_delay = train_test_split(X, df["pre_berthing_delay_hr"], test_size=0.2, random_state=42)
    _, _, y_train_yard, y_test_yard = train_test_split(X, df["yard_utilization_pct"], test_size=0.2, random_state=42)

    print("Training XGBoost Models (this will be fast!)...")
    model_turnaround = XGBRegressor(n_estimators=100, random_state=42, n_jobs=4)
    model_delay = XGBRegressor(n_estimators=100, random_state=42, n_jobs=4)
    model_yard = XGBRegressor(n_estimators=100, random_state=42, n_jobs=4)

    # Train the models on the training set
    model_turnaround.fit(X_train, y_train_turnaround)
    model_delay.fit(X_train, y_train_delay)
    model_yard.fit(X_train, y_train_yard)

    # 2. NEW: VERIFICATION - Score the models on the test set
    print("\n--- MODEL VERIFICATION REPORT ---")
    
    def evaluate(model, X_t, y_t, name, unit):
        preds = model.predict(X_t)
        mae = mean_absolute_error(y_t, preds)
        r2 = r2_score(y_t, preds)
        print(f"{name}:")
        print(f"  Accuracy (R² Score): {r2 * 100:.1f}%")
        print(f"  Average Error: ±{mae:.2f} {unit}\n")

    evaluate(model_turnaround, X_test, y_test_turnaround, "Vessel Turnaround", "hours")
    evaluate(model_delay, X_test, y_test_delay, "Pre-Berthing Delay", "hours")
    evaluate(model_yard, X_test, y_test_yard, "Yard Utilization", "%")
    print("---------------------------------\n")

    # The rest remains exactly the same for your Dashboard
    print("Generating predictions for the Dashboard UI...")
    dash_df = df.sample(n=min(3000, len(df)), random_state=42).copy()
    X_dash = pd.get_dummies(dash_df[features]).reindex(columns=X.columns, fill_value=0)

    # We use the trained models to predict
    dash_df["turnaround_pred"] = model_turnaround.predict(X_dash)
    dash_df["delay_pred"] = model_delay.predict(X_dash)
    dash_df["yard_pred"] = model_yard.predict(X_dash)
    
    final_df = pd.DataFrame()
    final_df['vessel_id'] = ["VSL" + str(i).zfill(5) for i in range(1, len(dash_df) + 1)]
    final_df['vessel_name'] = final_df['vessel_id']
    final_df['shipping_line'] = dash_df['flow_type'].apply(lambda x: "Hapag-Lloyd" if x == "Import" else "Maersk").values
    final_df['terminal_code'] = dash_df['terminal'].values
    final_df['candidate_berth'] = dash_df['terminal'].astype(str) + "01"
    
    final_df['eta_deviation_min'] = (dash_df['delay_pred'] * 45).astype(int).values 
    final_df['pre_berthing_delay_min'] = (dash_df['delay_pred'] * 60).astype(int).values
    final_df['service_time_min'] = (dash_df['berth_hours'] * 60).astype(int).values
    final_df['vessel_turnaround_min'] = (dash_df['turnaround_pred'] * 60).astype(int).values
    final_df['berth_pressure_index'] = (dash_df['yard_pred'] / 80.0).round(3).values
    final_df['berth_conflict_flag'] = (dash_df['yard_pred'] > 85).astype(int).values

    final_df['weather_risk_index'] = 0.15
    final_df['channel_congestion_index'] = 0.2
    final_df['crane_allocation_count'] = 3
    
    output_name = "usecase1_predictions.json"
    final_df.to_json(output_name, orient="records")
    print(f"SUCCESS! Exported '{output_name}'")

if __name__ == "__main__":
    main()