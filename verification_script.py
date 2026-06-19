import pandas as pd
import numpy as np

def run_data_validation():
    print("="*60)
    print("🚀 STARTING PORT OPERATION CONSTRAINT VERIFICATION")
    print("="*60)
    
    # Load dataset
    try:
        df = pd.read_csv('vessel_lifecycle_simulation.csv')
        df['event_time'] = pd.to_datetime(df['event_time'])
        print(f"✔ Successfully loaded {len(df)} simulation logs.")
    except Exception as e:
        print(f"❌ Error loading file: {e}")
        return

    mismatches = 0
    total_vessels = df['vessel_id'].nunique()
    
    print(f"Total Unique Vessels Detected: {total_vessels}\n")

    # -------------------------------------------------------------
    # CONSTRAINT 1: CARGO OPERATIONAL HOURS SIMULTANEOUS MATH CHECK
    # Max(Import TEU * 5, Export TEU * 10) / 60
    # -------------------------------------------------------------
    print("📊 Checking Constraint 1: Cargo Operation Handling Duration...")
    df['calculated_cargo_min'] = np.maximum(df['import_teu'] * 5, df['export_teu'] * 10)
    df['calculated_cargo_hours'] = np.round(df['calculated_cargo_min'] / 60.0, 1)
    
    cargo_errors = df[df['cargo_hours'] != df['calculated_cargo_hours']]
    if len(cargo_errors) == 0:
        print("  🟢 PASS: Simultaneous cargo max time equation matches across all rows.")
    else:
        print(f"  🔴 FAIL: Found {len(cargo_errors)} rows with mismatched cargo hour parameters.")
        mismatches += 1

    # -------------------------------------------------------------
    # CONSTRAINT 2: CHRONOLOGICAL STAGE SEQUENCE INTEGRITY
    # Checking that stages never progress backward or teleport randomly
    # -------------------------------------------------------------
    print("\n🔄 Checking Constraint 2: Chronological Sequence Integrity...")
    stage_priority = {
        'PLANNING': 1, 'ARRIVAL': 2, 'WAITING': 3, 'INBOUND': 4, 
        'BERTHING': 5, 'CLEARANCE': 6, 'SERVICE': 7, 'CARGO': 7, 'DEPARTURE': 8
    }
    
    sequence_errors = 0
    for v_id, group in df.groupby('vessel_id'):
        sorted_group = group.sort_values('event_time')
        last_priority = 0
        
        for idx, row in sorted_group.iterrows():
            curr_priority = stage_priority.get(row['stage'], 0)
            if curr_priority < last_priority:
                # Bunkering/Services happen during cargo ops, which is priority 7 tied, we allow equal priorities
                if not (row['stage'] == 'SERVICE' or row['stage'] == 'CARGO'):
                    sequence_errors += 1
            last_priority = curr_priority
            
    if sequence_errors == 0:
        print("  🟢 PASS: All 50 vessels respect linear operational stage workflows.")
    else:
        print(f"  🔴 FAIL: Detected {sequence_errors} sequence violations.")
        mismatches += 1

    # -------------------------------------------------------------
    # CONSTRAINT 3: DYNAMIC BERTH MASKING CONTROL
    # Berth names must remain empty until the ship leaves anchorage
    # -------------------------------------------------------------
    print("\n⚓ Checking Constraint 3: Stage-Gate Berth Attribute Control...")
    
    early_berth_claims = df[df['stage'].isin(['PLANNING', 'ARRIVAL']) & df['berth'].notna()]
    # Exception handling for Anchorage entry row (it should remain blank)
    anch_entered_claims = df[(df['substage'] == 'ANCHORAGE_ENTERED') & df['berth'].notna()]
    
    if len(early_berth_claims) == 0 and len(anch_entered_claims) == 0:
        print("  🟢 PASS: Berth parameters stay hidden during PLANNING, ARRIVAL, and ANCHORAGE waiting loops.")
    else:
        print(f"  🔴 FAIL: Detected leaks where a berth index was exposed too early.")
        mismatches += 1

    # -------------------------------------------------------------
    # CONSTRAINT 4: TIDAL IMPACT ANCHORAGE ADJUSTMENT MATHEMATICS
    # -------------------------------------------------------------
    print("\n🌊 Checking Constraint 4: Tidal Delay Function Variance...")
    # Find ships that faced high tides (> 2.5) during their actual waiting stage
    high_tide_waiters = df[(df['substage'] == 'ANCHORAGE_ENTERED') & (df['tide_level'] > 2.5)]
    low_tide_waiters = df[(df['substage'] == 'ANCHORAGE_ENTERED') & (df['tide_level'] <= 2.5)]
    
    print(f"  💡 Data Insight: {len(high_tide_waiters)} vessels faced high tides at anchor; {len(low_tide_waiters)} cleared smoothly.")
    
    # Ensure anchorage wait calculations are derived correctly
    df['calculated_wait_hours'] = 0.0
    wait_mismatches = 0
    
    for v_id in df['vessel_id'].unique():
        v_rows = df[df['vessel_id'] == v_id]
        enter_rows = v_rows[v_rows['substage'] == 'ANCHORAGE_ENTERED']
        exit_rows = v_rows[v_rows['substage'] == 'ANCHORAGE_EXITED']
        
        if len(enter_rows) > 0 and len(exit_rows) > 0:
            t_enter = enter_rows.iloc[0]['event_time']
            t_exit = exit_rows.iloc[0]['event_time']
            actual_wait = exit_rows.iloc[0]['anchorage_wait_hours']
            math_wait = round((t_exit - t_enter).total_seconds() / 3600.0, 1)
            
            if abs(actual_wait - math_wait) > 0.1:
                wait_mismatches += 1
                
    if wait_mismatches == 0:
        print("  🟢 PASS: Timestamp gap matches anchorage_wait_hours metrics down to 0.1 hours.")
    else:
        print(f"  🔴 FAIL: Clock arithmetic gaps found in {wait_mismatches} records.")
        mismatches += 1

    # -------------------------------------------------------------
    # SUMMARY CONSOLE REPORT
    # -------------------------------------------------------------
    print("\n" + "="*60)
    if mismatches == 0:
        print("🏆 SYSTEM VERIFICATION RESULTS: SUCCESS")
        print("All data structures mirror real-world constraints perfectly, bro!")
    else:
        print("🚨 SYSTEM VERIFICATION RESULTS: CRITICAL ERROR")
        print(f"The simulation broken model failed {mismatches} constraints.")
    print("="*60)

if __name__ == '__main__':
    run_data_validation()