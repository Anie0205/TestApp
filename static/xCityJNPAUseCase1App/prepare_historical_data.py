import pandas as pd

# 1. Load the new 5-year dataset
df = pd.read_csv("jnpa_ai_historical_5year_package/ml/jnpa_ai_training_dataset_2022_2026.csv")

# 2. Aggregate from Container-level back to Vessel-level
vessel_df = df.groupby('vessel_call_id').agg({
    'terminal': 'first',
    'year': 'first',
    'month': 'first',
    'container_count_on_vessel': 'max',
    'berth_hours': 'mean',
    'crane_moves_per_hour': 'mean',
    'pre_berthing_delay_hr': 'mean',
    'vessel_turnaround_hr': 'mean',
    'yard_utilization_pct': 'mean'
}).reset_index()

# 3. Rename columns to match your existing JavaScript UI
vessel_df.rename(columns={
    'vessel_call_id': 'vessel_id',
    'terminal': 'terminal_code',
    'pre_berthing_delay_hr': 'pre_berthing_delay_min', 
    'vessel_turnaround_hr': 'vessel_turnaround_min'
}, inplace=True)

# 4. Convert hours to minutes so your JS charts don't break
vessel_df['pre_berthing_delay_min'] = vessel_df['pre_berthing_delay_min'] * 60
vessel_df['vessel_turnaround_min'] = vessel_df['vessel_turnaround_min'] * 60

# 5. Add fallback columns for your JS Dropdowns so they don't show "undefined"
vessel_df['candidate_berth'] = vessel_df['terminal_code'] + "01" 
vessel_df['shipping_line'] = "Historical" 
vessel_df['vessel_name'] = vessel_df['vessel_id']

# 6. Export directly to the JSON file your widget is already looking for!
vessel_df.to_json('usecase1_predictions.json', orient='records')
print(f"Successfully exported {len(vessel_df)} aggregated vessels to JSON!")