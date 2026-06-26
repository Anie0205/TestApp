#!/usr/bin/env python3
"""
JNPA Operational Control Tower - Synchronized Simulation Generator (data_gen.py)
================================================================================
Implements a strict, high-fidelity Discrete Event Simulation (DES) to model:
1. Sea-side Vessel Lifecycles (Tide constraints, pilotage, bunkering)
2. Export Container Land-to-Sea Lifecycles (ICEGATE LEO, CPP Gates, VGM, stacks)
3. Import Container Sea-to-Land Lifecycles (ICEGATE OOC, Yard RMGs, truck gates)

Guarantees 100% relational consistency and mathematical alignments:
- anchorage_wait_hours = round((ANCHORAGE_EXITED - ANCHORAGE_ENTERED) in hours, 1)
- cargo_hours = round(max(import_teu * 5, export_teu * 10) / 60.0, 1)
- Tide elevations calculated via standard continuous semidiurnal sinusoid.

Outputs:
- vessels_master.csv
- berths_master.csv
- containers_master.csv
- trucks_master.csv
- vessel_lifecycle_simulation.csv
"""

import pandas as pd
import numpy as np
import datetime
import math
import random

# Set random seeds for perfect reproducibility
np.random.seed(42)
random.seed(42)

# Configuration Parameters
NUM_VESSELS = 50
START_DATE = datetime.datetime(2026, 3, 1, 0, 0, 0)

# Real-World JNPA Cargo Infrastructure Mapping
CONTAINER_TYPE_POOLS = {
    'DRY_VAN': {
        'terminals': ['T1', 'T2'],
        'berths': {
            'T1': ['B1', 'B2', 'B3'],
            'T2': ['B4', 'B5', 'B6']
        },
        'depths': {'T1': 16.5, 'T2': 15.0},
        'yards': {'T1': 'Yard A', 'T2': 'Yard B'}
    },
    'REEFER_CARGO': {
        'terminals': ['T3', 'T4'],
        'berths': {
            'T3': ['B7', 'B8'],
            'T4': ['B9', 'B10']
        },
        'depths': {'T3': 13.5, 'T4': 12.5},
        'yards': {'T3': 'Yard C', 'T4': 'Yard D'}
    }
}

VESSEL_DRAFTS = {
    'Feeder': 9.2,
    'Regional': 11.0,
    'Panamax': 12.6,
    'ULCV': 14.6
}

SHIPPING_LINES = ['EVERGREEN', 'HAPAG', 'MSC', 'CMA CGM', 'MAERSK', 'ONE']
VESSEL_CLASSES = ['Feeder', 'Regional', 'Panamax', 'ULCV']

# Semidiurnal Tide function (0.5m to 4.5m depth variation)
def get_tide_level(time_val):
    hours = (time_val - START_DATE).total_seconds() / 3600.0
    return 2.5 + 2.0 * math.cos((2.0 * math.pi * (hours - 4.0)) / 12.42)

# Dynamic state tracking to prevent berth overlaps
berth_busy_until = {
    'B1': START_DATE, 'B2': START_DATE, 'B3': START_DATE,
    'B4': START_DATE, 'B5': START_DATE, 'B6': START_DATE,
    'B7': START_DATE, 'B8': START_DATE,
    'B9': START_DATE, 'B10': START_DATE
}

def generate_simulation():
    print("🚀 Running Scaled JNPA Multi-Domain State Simulation...")
    all_rows = []
    
    # Registries for master/metadata tables
    vessels_master_rows = []
    berths_master_rows = []
    containers_master_rows = []
    trucks_master_rows = []

    # 1. Populate Berth Infrastructure Master Data
    for cargo_type, pool in CONTAINER_TYPE_POOLS.items():
        for terminal in pool['terminals']:
            depth = pool['depths'][terminal]
            for berth in pool['berths'][terminal]:
                berths_master_rows.append({
                    'berth_id': berth,
                    'terminal_id': terminal,
                    'dredge_depth_m': depth,
                    'supported_cargo_type': cargo_type,
                    'allocated_yard_block': pool['yards'][terminal]
                })

    # Stagger ETA arrivals across a 6-day window
    arrival_offsets = np.sort(np.random.uniform(0, 144, NUM_VESSELS))

    # Counters to assign exactly 5,000 unique trucks and 10,000 containers
    export_truck_counter = 0

    # 2. Pre-generate and serialize 5,000 Master Truck Registries
    for t_idx in range(1, 5001):
        plate = f"MH-46-TRK-{t_idx:04d}"
        trucks_master_rows.append({
            'truck_id': plate,
            'tare_weight_kg': int(14000 + (t_idx * 17) % 4000),
            'operator_code': 'CONTRANS' if t_idx % 2 == 0 else 'GATEWAY_LOG',
            'fuel_type': 'CNG' if t_idx % 3 == 0 else 'DIESEL'
        })

    for i in range(1, NUM_VESSELS + 1):
        vessel_id = f"V{i:04d}"
        voyage_no = f"VOY{i:05d}"
        shipping_line = SHIPPING_LINES[(i - 1) % len(SHIPPING_LINES)]
        vessel_class = VESSEL_CLASSES[(i - 1) % len(VESSEL_CLASSES)]
        draft = VESSEL_DRAFTS[vessel_class]

        # Symmetrically distribute 10,000 container flows (5,000 imports, 5,000 exports)
        # Using repeating offsets to ensure exact aggregate counts over 50 vessels
        import_teu = int(100 + (i % 5 - 2) * 10) # range: 80 to 120 (sum over 50 vessels = exactly 5,000)
        export_teu = int(100 + ((i + 2) % 5 - 2) * 10) # range: 80 to 120 (sum over 50 vessels = exactly 5,000)
        teu_capacity = int(vessel_class == 'Feeder' and 2500 or \
                           vessel_class == 'Regional' and 4800 or \
                           vessel_class == 'Panamax' and 8500 or 14000)

        # 3. Populate Vessel Registry Master Data
        vessels_master_rows.append({
            'vessel_id': vessel_id,
            'shipping_line': shipping_line,
            'vessel_class': vessel_class,
            'draft_design_m': draft,
            'teu_capacity': teu_capacity
        })

        # Mapped terminal & berth pools
        container_type = 'DRY_VAN' if (i % 2 != 0) else 'REEFER_CARGO'
        pool = CONTAINER_TYPE_POOLS[container_type]
        terminal = pool['terminals'][(i - 1) % 2]
        available_berths = pool['berths'][terminal]
        terminal_depth = pool['depths'][terminal]
        yard_block = pool['yards'][terminal]

        # Staggered Arrival Time
        eta_received = START_DATE + datetime.timedelta(hours=arrival_offsets[i - 1]) - datetime.timedelta(hours=2)
        anchorage_enter = eta_received + datetime.timedelta(minutes=15)

        # -------------------------------------------------------------
        # DES QUEUE SOLVER: Find safe tide + berth vacant window
        # -------------------------------------------------------------
        berth_assigned = None
        berth_time = None
        transit_delay = datetime.timedelta(minutes=45) # travel time from anchorage to berth

        scan_time = anchorage_enter
        # Resolve berth based on safe draft clearance under semidiurnal tide
        while berth_assigned is None:
            # Check berth vacancy sequentially
            for b in available_berths:
                if berth_busy_until[b] <= scan_time:
                    # Check Tide depth gate clearance: depth + tide - draft >= 1.0m (UKC Safety Margin)
                    tide_at_scan = get_tide_level(scan_time)
                    if (terminal_depth + tide_at_scan - draft) >= 1.0:
                        # Confirm tide is also safe when actually berthed (45 mins later)
                        tide_at_berth = get_tide_level(scan_time + transit_delay)
                        if (terminal_depth + tide_at_berth - draft) >= 1.0:
                            berth_assigned = b
                            berth_time = scan_time + transit_delay
                            break
            if berth_assigned is None:
                scan_time += datetime.timedelta(minutes=5) # Scan forward in 5-min increments

        anchorage_exit = scan_time
        anchorage_wait_hours = round((anchorage_exit - anchorage_enter).total_seconds() / 3600.0, 1)

        # -------------------------------------------------------------
        # OPERATIONS TIMELINE MATH SOLVER
        # -------------------------------------------------------------
        cargo_hours = round(max(import_teu * 5, export_teu * 10) / 60.0, 1)
        
        # Proportional discharge vs loading phase split
        discharge_fraction = (import_teu * 5) / (import_teu * 5 + export_teu * 10)
        discharge_hours = cargo_hours * discharge_fraction
        load_hours = cargo_hours * (1.0 - discharge_fraction)

        discharge_start = berth_time + datetime.timedelta(minutes=15)
        discharge_end = discharge_start + datetime.timedelta(hours=discharge_hours)

        load_start = discharge_end + datetime.timedelta(minutes=15)
        load_end = load_start + datetime.timedelta(hours=load_hours)

        bunkering_start = load_end + datetime.timedelta(minutes=15)
        bunkering_end = bunkering_start + datetime.timedelta(hours=1.0)

        # Dynamic exit tide check: ensure depth + tide - draft >= 1.0m before unberthing
        unberth_candidate = bunkering_end + datetime.timedelta(minutes=15)
        tide_hold_seconds = 0
        while (terminal_depth + get_tide_level(unberth_candidate) - draft) < 1.0:
            unberth_candidate += datetime.timedelta(minutes=5)
            tide_hold_seconds += 300

        unberth_time = unberth_candidate
        sailed_time = unberth_time + datetime.timedelta(minutes=30)

        # Lock the berth until unberthing is complete
        berth_busy_until[berth_assigned] = unberth_time

        # Create master dictionary with matching row-level validation stats to support verification
        vessel_meta = {
            'vessel_id': vessel_id,
            'voyage_no': voyage_no,
            'shipping_line': shipping_line,
            'vessel_class': vessel_class,
            'teu_capacity': teu_capacity,
            'import_teu': import_teu,
            'export_teu': export_teu,
            'container_type': container_type,
            'terminal': terminal,
            'berth': berth_assigned,
            'weather': 'CLEAR',
            'tide_level': 2.5,
            'anchorage_wait_hours': anchorage_wait_hours,
            'cargo_hours': cargo_hours,
            'entity_type': 'VESSEL',
            'entity_id': vessel_id,
            'status_details': ""
        }

        # -------------------------------------------------------------
        # EVENT LOGS ASSEMBLER
        # -------------------------------------------------------------
        raw_events = []

        # -- SEA-SIDE VESSEL TIMELINE --
        raw_events.append((eta_received, 'PLANNING', 'ETA_RECEIVED', 0, "", 'VESSEL', vessel_id, 
                           f"Vessel {vessel_id} ({shipping_line} {vessel_class}) transmitted active transponder ETA."))
        
        delay_reason = "CONGESTION" if anchorage_wait_hours > 2.0 else ""
        raw_events.append((anchorage_enter, 'PLANNING', 'ANCHORAGE_ENTERED', 0, delay_reason, 'VESSEL', vessel_id,
                           f"Vessel {vessel_id} entered outer anchorage boundary pool. Wait status: {delay_reason or 'NORMAL'}."))
        
        raw_events.append((anchorage_exit, 'PLANNING', 'ANCHORAGE_EXITED', 0, delay_reason, 'VESSEL', vessel_id,
                           f"Anchorage pool cleared. Vessel pilotage initiated towards Berth {berth_assigned}."))
        
        cranes_assigned = 4 if vessel_class == 'ULCV' else 3 if vessel_class == 'Panamax' else 2
        raw_events.append((berth_time, 'MOORING', 'BERTHED', cranes_assigned, "", 'VESSEL', vessel_id,
                           f"Vessel securely moored at {terminal} Berth {berth_assigned}. Draft window clearance verified."))

        raw_events.append((discharge_start, 'CARGO', 'DISCHARGE_STARTED', cranes_assigned, "", 'VESSEL', vessel_id,
                           f"Quay crane hoists deployed. Discharge operations started for {import_teu} import TEUs."))

        # Discharge progress indicators
        for p in [20, 40, 60, 80]:
            p_time = discharge_start + datetime.timedelta(hours=discharge_hours * (p / 100.0))
            raw_events.append((p_time, 'CARGO', f'PROGRESS_{p}', cranes_assigned, "", 'VESSEL', vessel_id,
                               f"Discharge operations reached {p}% completion progress boundary."))

        raw_events.append((discharge_end, 'CARGO', 'DISCHARGE_COMPLETED', cranes_assigned, "", 'VESSEL', vessel_id,
                           f"All import containers successfully discharged to Terminal {terminal} yard blocks."))

        raw_events.append((load_start, 'CARGO', 'LOAD_STARTED', cranes_assigned, "", 'VESSEL', vessel_id,
                           f"Quay cranes transitioned to load export cargo. Planned target: {export_teu} export TEUs."))

        # Load progress indicators
        for p in [20, 40, 60, 80]:
            p_time = load_start + datetime.timedelta(hours=load_hours * (p / 100.0))
            raw_events.append((p_time, 'CARGO', f'PROGRESS_{p}', cranes_assigned, "", 'VESSEL', vessel_id,
                               f"Load operations reached {p}% completion progress boundary."))

        raw_events.append((load_end, 'CARGO', 'LOAD_COMPLETED', cranes_assigned, "", 'VESSEL', vessel_id,
                           f"Export container loading cycle finalized. LEO documents cleared."))

        raw_events.append((bunkering_start, 'SERVICE', 'BUNKERING_STARTED', 0, "", 'VESSEL', vessel_id,
                           f"Bunker fuel replenishment vessel secured alongside. Bunkering initiated."))

        raw_events.append((bunkering_end, 'SERVICE', 'BUNKERING_COMPLETED', 0, "", 'VESSEL', vessel_id,
                           f"Fueling operations finalized. Cast off bunkering barge."))

        exit_delay = "TIDE_HOLD" if tide_hold_seconds > 0 else ""
        raw_events.append((unberth_time, 'MOORING', 'UNBERTHED', 0, exit_delay, 'VESSEL', vessel_id,
                           f"Mooring lines released. Vessel unberthed. Tide hold penalty assessed: {tide_hold_seconds // 60} mins."))

        raw_events.append((sailed_time, 'MOORING', 'SAILED', 0, exit_delay, 'VESSEL', vessel_id,
                           f"Vessel {vessel_id} passed port harbor limits and sailed outbound."))


        # -- LANDSIDE EXPORT CONTAINER LIFECYCLE (scaled to exact target size) --
        for k in range(1, export_teu + 1):
            export_truck_counter += 1
            c_id = f"JNPU-EX-{vessel_id}-{k:03d}"
            t_plate = f"MH-46-TRK-{export_truck_counter:04d}"
            weight = int(12000 + (k * 37) % 18000)
            yard_bay = f"BAY-{k:03d}"

            # 4. Populate Export Container Master Table Row
            containers_master_rows.append({
                'container_id': c_id,
                'direction': 'EXPORT',
                'container_type': 'DRY' if container_type == 'DRY_VAN' else 'REEFER',
                'vessel_id': vessel_id,
                'voyage_no': voyage_no,
                'gross_weight_kg': weight,
                'assigned_yard_block': yard_block,
                'assigned_yard_bay': yard_bay
            })

            # Time offsets calculated dynamically back from mooring times
            t_booked = eta_received - datetime.timedelta(hours=24 + k * 0.1)
            t_sb_filed = t_booked + datetime.timedelta(hours=1, minutes=15)
            
            # Probability of customs scanning inspection
            has_inspection = (k % 7 == 0) 
            leo_delay = datetime.timedelta(hours=4) if has_inspection else datetime.timedelta(minutes=15)
            t_leo = t_sb_filed + datetime.timedelta(hours=1) + leo_delay
            
            t_cpp_in = t_leo + datetime.timedelta(hours=1, minutes=30)
            t_cpp_out = t_cpp_in + datetime.timedelta(minutes=30)
            t_pregate = t_cpp_out + datetime.timedelta(minutes=15)
            
            # OCR scanning confidence check
            has_ocr_delay = (k % 11 == 0)
            ocr_delay = datetime.timedelta(minutes=15) if has_ocr_delay else datetime.timedelta(0)
            t_gate_in = t_pregate + datetime.timedelta(minutes=10) + ocr_delay
            
            t_stack_start = t_gate_in + datetime.timedelta(minutes=10)
            
            # Stack stability density checks
            has_rehandle = (k % 13 == 0)
            rehandle_delay = datetime.timedelta(minutes=20) if has_rehandle else datetime.timedelta(0)
            t_stacked = t_stack_start + datetime.timedelta(minutes=5) + rehandle_delay
            
            t_gate_out = t_stacked + datetime.timedelta(minutes=5)
            t_loaded = load_start + datetime.timedelta(hours=load_hours * (k / (export_teu + 1.0)))

            raw_events.append((t_booked, 'BOOKING', 'CONTAINER_BOOKED', 0, "", 'CONTAINER', c_id,
                               f"Booking confirmed for outbound cargo container. Declared weight: {weight} kg."))
            
            raw_events.append((t_sb_filed, 'CUSTOMS', 'CONTAINER_SB_FILED', 0, "", 'CONTAINER', c_id,
                               "Shipping Bill successfully filed via ICEGATE portal. Assessing RMS risk profile."))
            
            rms_route = "SCANNER_PHYSICAL_HOLD" if has_inspection else "GREEN_CHANNEL"
            raw_events.append((t_leo, 'CUSTOMS', 'CONTAINER_CUSTOMS_LEO', 0, "", 'CONTAINER', c_id,
                               f"Let Export Order (LEO) granted by Customs. Risk Management System route: {rms_route}."))
            
            raw_events.append((t_cpp_in, 'GATES', 'TRUCK_CPP_GATE_IN', 0, "", 'TRUCK', t_plate,
                               f"Transporter road truck {t_plate} reached Central Parking Plaza (CPP). Processing validation."))
            
            raw_events.append((t_cpp_out, 'GATES', 'TRUCK_CPP_GATE_OUT', 0, "", 'TRUCK', t_plate,
                               "Equipment Interchange Receipt (EIR) printed. Cleared CPP parking towards terminal gate."))
            
            vgm_reading = weight + int(random.uniform(-50, 50))
            raw_events.append((t_pregate, 'GATES', 'TRUCK_TERMINAL_PRE_GATE', 0, "", 'TRUCK', t_plate,
                               f"VGM Verification scale weight: {vgm_reading} kg. OCR boundary license recognition: SUCCESS."))
            
            raw_events.append((t_gate_in, 'GATES', 'TRUCK_TERMINAL_GATE_IN', 0, "", 'TRUCK', t_plate,
                               f"Terminal Gate-In cleared. Routing chassis directly to storage block: {yard_block}."))
            
            raw_events.append((t_stack_start, 'YARD', 'CONTAINER_YARD_STACK_START', 0, "", 'CONTAINER', c_id,
                               f"RMG Crane lift sequence initiated inside Block {yard_block} at slot coordinate {yard_bay}."))
            
            re_desc = "Rehandling Stack Shunt Penalty assessed: Weight density inversion." if has_rehandle else "Safe stack placement approved."
            raw_events.append((t_stacked, 'YARD', 'CONTAINER_YARD_STACKED', 0, "", 'CONTAINER', c_id,
                               f"Container successfully stacked in yard slot coordinates. Status: {re_desc}"))
            
            raw_events.append((t_gate_out, 'GATES', 'TRUCK_TERMINAL_GATE_OUT', 0, "", 'TRUCK', t_plate,
                               "Empty export delivery transporter truck cleared boundary scales and gated out."))
            
            raw_events.append((t_loaded, 'CARGO', 'CONTAINER_LOADED', cranes_assigned, "", 'CONTAINER', c_id,
                               f"Quay Crane hoisted export container on-board vessel {vessel_id}."))


        # -- LANDSIDE IMPORT CONTAINER LIFECYCLE (scaled to exact target size) --
        for k in range(1, import_teu + 1):
            c_id = f"JNPU-IM-{vessel_id}-{k:03d}"
            # Recycle the 5,000 unique trucks dynamically for realistic retrieval cycles
            import_truck_idx = (export_truck_counter - import_teu + k) % 5000
            import_truck_idx = 5000 if import_truck_idx == 0 else import_truck_idx
            t_plate = f"MH-46-TRK-{import_truck_idx:04d}"
            weight = int(14000 + (k * 22) % 15000)
            yard_bay = f"BAY-{k:03d}"

            # 5. Populate Import Container Master Table Row
            containers_master_rows.append({
                'container_id': c_id,
                'direction': 'IMPORT',
                'container_type': 'DRY' if container_type == 'DRY_VAN' else 'REEFER',
                'vessel_id': vessel_id,
                'voyage_no': voyage_no,
                'gross_weight_kg': weight,
                'assigned_yard_block': yard_block,
                'assigned_yard_bay': yard_bay
            })

            # Grounded in yard during active vessel discharging phase
            t_discharged = discharge_start + datetime.timedelta(hours=discharge_hours * (k / (import_teu + 1.0)))
            t_stack_start = t_discharged + datetime.timedelta(minutes=10)
            t_stacked = t_stack_start + datetime.timedelta(minutes=5)
            
            # Starts Import customs clearance sequence
            t_ooc_start = t_stacked + datetime.timedelta(minutes=20)
            t_ooc = t_ooc_start + datetime.timedelta(hours=2, minutes=30)
            
            t_gate_in = t_ooc + datetime.timedelta(minutes=30) # pickup truck gates in
            t_dispatch = t_gate_in + datetime.timedelta(minutes=10) # RMG loads container on truck
            t_gate_out = t_dispatch + datetime.timedelta(minutes=8) # leaves port boundary

            raw_events.append((t_discharged, 'CARGO', 'CONTAINER_DISCHARGED', cranes_assigned, "", 'CONTAINER', c_id,
                               f"Discharge hoist completed. Lifting import container from cell deck onto terminal chassis."))
            
            raw_events.append((t_stack_start, 'YARD', 'CONTAINER_YARD_STACK_START', 0, "", 'CONTAINER', c_id,
                               f"RMG Crane initiated grounding maneuver in storage block {yard_block} at slot {yard_bay}."))
            
            raw_events.append((t_stacked, 'YARD', 'CONTAINER_YARD_STACKED', 0, "", 'CONTAINER', c_id,
                               "Container successfully grounded in yard stack coordinates. Inventory records updated."))
            
            raw_events.append((t_ooc_start, 'CUSTOMS', 'CONTAINER_IMPORT_OOC_START', 0, "", 'CONTAINER', c_id,
                               "Consignee filed Bill of Entry customs assessment clearance. Assessment pending."))
            
            raw_events.append((t_ooc, 'CUSTOMS', 'CONTAINER_CUSTOMS_OOC', 0, "", 'CONTAINER', c_id,
                               "ICEGATE Out of Charge (OOC) granted. Consignee truck authorized for cargo pickup."))
            
            raw_events.append((t_gate_in, 'GATES', 'TRUCK_IMPORT_GATE_IN', 0, "", 'TRUCK', t_plate,
                               f"Consignee road pickup truck {t_plate} gated into terminal to fetch cleared import container."))
            
            raw_events.append((t_dispatch, 'YARD', 'CONTAINER_IMPORT_DISPATCH', 0, "", 'CONTAINER', c_id,
                               f"RMG Crane safely loaded import container onto truck chassis {t_plate}."))
            
            raw_events.append((t_gate_out, 'GATES', 'TRUCK_IMPORT_GATE_OUT', 0, "", 'TRUCK', t_plate,
                               f"Import pickup transporter truck {t_plate} cleared scales and gated out of port boundary."))


        # -------------------------------------------------------------
        # CAUSALLY-VERIFIED DATA STRUCTURING
        # -------------------------------------------------------------
        for ev_time, stage, substage, cr_val, delay_val, ent_type, ent_id, detail_desc in raw_events:
            row = vessel_meta.copy()
            row['event_time'] = ev_time.strftime('%Y-%m-%d %H:%M:%S')
            row['berth'] = berth_assigned if ent_type == 'VESSEL' or substage in ['CONTAINER_LOADED', 'CONTAINER_DISCHARGED'] else ""
            row['stage'] = stage
            row['substage'] = substage
            row['cranes_assigned'] = cr_val
            row['delay_reason'] = delay_val
            row['tide_level'] = round(get_tide_level(ev_time), 2)
            row['entity_type'] = ent_type
            row['entity_id'] = ent_id
            row['status_details'] = detail_desc
            
            all_rows.append(row)

    # Convert to DataFrames and export master tables
    print("💾 Serialization of scaled registries to CSV initiated...")
    
    df_vessels_master = pd.DataFrame(vessels_master_rows)
    df_vessels_master.to_csv('vessels_master.csv', index=False)
    print(f"  ✔ Generated 'vessels_master.csv' with {len(df_vessels_master)} ship registries.")

    df_berths_master = pd.DataFrame(berths_master_rows)
    df_berths_master.to_csv('berths_master.csv', index=False)
    print(f"  ✔ Generated 'berths_master.csv' with {len(df_berths_master)} physical berth layouts.")

    df_containers_master = pd.DataFrame(containers_master_rows)
    df_containers_master.to_csv('containers_master.csv', index=False)
    print(f"  ✔ Generated 'containers_master.csv' with {len(df_containers_master)} container asset records.")

    df_trucks_master = pd.DataFrame(trucks_master_rows)
    df_trucks_master.to_csv('trucks_master.csv', index=False)
    print(f"  ✔ Generated 'trucks_master.csv' with {len(df_trucks_master)} unique master truck registrations.")

    # Sort and save all transactional events chronologically
    df_result = pd.DataFrame(all_rows)
    df_result['parsed_time'] = pd.to_datetime(df_result['event_time'])
    df_result = df_result.sort_values(by='parsed_time').drop(columns=['parsed_time'])

    df_result.to_csv('vessel_lifecycle_simulation.csv', index=False)
    print(f"✔ Successfully generated {len(df_result)} multi-lifecycle logs in 'vessel_lifecycle_simulation.csv'!")

if __name__ == '__main__':
    generate_simulation()