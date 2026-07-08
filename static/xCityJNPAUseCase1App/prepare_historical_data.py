import pandas as pd
from pathlib import Path

def main():
    base_dir = Path("jnpa_ai_historical_5year_package/historical_data")
    years = ["2022", "2023", "2024", "2025", "2026"]
    
    all_years_data = []
    print("Starting Data Lake Extraction...")

    for year in years:
        year_path = base_dir / year
        print(f"\nProcessing Year: {year}...")
        
        try:
            # 1. Load and clean headers
            containers = pd.read_csv(year_path / "container_master.csv")
            containers.columns = containers.columns.str.strip()
            
            cranes = pd.read_csv(year_path / "berth_crane_operations.csv")
            cranes.columns = cranes.columns.str.strip()

            # CRITICAL FIX: Force Pandas to keep ONLY the columns we actually need.
            # This prevents it from accidentally creating 'terminal_x' and 'terminal_y' during the merge.
            containers_clean = containers[['vessel_call_id', 'terminal']]
            cranes_clean = cranes[['vessel_call_id', 'berth_hours', 'crane_moves_per_hour']]

            # 2. Count containers per vessel AND grab the terminal name
            vessel_volumes = containers_clean.groupby(['vessel_call_id', 'terminal']).size().reset_index(name='total_container_volume')

            # 3. Join the Volumes/Terminal data with the Crane Operations
            vessel_master = pd.merge(vessel_volumes, cranes_clean, on='vessel_call_id', how='inner')
            
            # 4. Add the year from the folder structure
            vessel_master['year'] = int(year)
            
            all_years_data.append(vessel_master)
            print(f"  -> {year} successful! Merged {len(vessel_master)} vessel records.")

        except FileNotFoundError as e:
            print(f"  -> ERROR: Missing a file for {year}. Skipping.")
            continue
        except KeyError as e:
            print(f"  -> ERROR: Column mismatch in {year}: {e}. Check your raw CSVs!")
            continue

    if not all_years_data:
        print("\nNo data found! Check your folder paths.")
        return

    # 5. Combine all years
    full_history_df = pd.concat(all_years_data, ignore_index=True)

    print("\nAggregating into comprehensive macro view...")
    
    # 6. Aggregate to the Macro-Level (Year and Terminal)
    macro_df = full_history_df.groupby(['year', 'terminal']).agg({
        'vessel_call_id': 'nunique',             # Total unique ships
        'total_container_volume': 'sum',         # Total TEUs
        'berth_hours': 'mean',                   # Average time at berth
        'crane_moves_per_hour': 'mean'           # Crane productivity
    }).reset_index()

    # 7. Rename columns for the JavaScript Dashboard
    macro_df.rename(columns={
        'vessel_call_id': 'total_vessels_handled',
        'berth_hours': 'avg_berth_hours',
        'crane_moves_per_hour': 'avg_crane_productivity'
    }, inplace=True)

    # Clean up the numbers
    macro_df = macro_df.round(2)

    # 8. Export to JSON
    output_filename = 'comprehensive_macro_view.json'
    macro_df.to_json(output_filename, orient='records')
    
    print("===================================================")
    print(f"SUCCESS! Exported {len(macro_df)} macro records to: {output_filename}")
    print("===================================================")

if __name__ == "__main__":
    main()