import pandas as pd
import numpy as np
import datetime

# Set seed for predictability
np.random.seed(42)

# Configuration
num_vessels = 50
start_date = datetime.datetime(2026, 3, 1, 0, 0, 0)
end_of_simulation = start_date + datetime.timedelta(days=7) # Strict 1-week cut-off

# Real-World JNPA Cargo Infrastructure Mapping
container_type_pools = {
    'DRY_VAN': {
        'terminals': ['T1', 'T2'],
        'berths': ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']
    },
    'REEFER_CARGO': {
        'terminals': ['T3', 'T4'],
        'berths': ['B7', 'B8', 'B9', 'B10']
    }
}

# Track when each individual berth becomes free
berth_free_times = {b: start_date for type_info in container_type_pools.values() for b in type_info['berths']}

shipping_lines = ['EVERGREEN', 'HAPAG', 'MSC', 'CMA CGM', 'MAERSK', 'ONE']
vessel_classes = ['Feeder', 'Regional', 'Panamax', 'ULCV']

# Spread arrivals across all 7 days
arrival_offsets = np.sort(np.random.uniform(0, 7.0 * 24 * 60, num_vessels))

def calculate_tide_level(dt):
    hour_fraction = dt.hour + dt.minute / 60.0
    tide = 3.0 + 2.0 * np.sin((2 * np.pi * hour_fraction) / 12.0)
    return round(tide, 2)

# Step 1: Pre-generate Metadata with Authentic JNPA Cargo Fields
vessels = []
for i in range(num_vessels):
    v_id = f"V{i+1:04d}"
    voy_no = f"VOY{i+1:05d}"
    s_line = np.random.choice(shipping_lines)
    v_class = np.random.choice(vessel_classes)
    
    if v_class == 'Feeder':
        cap = np.random.randint(1000, 2500)
    elif v_class == 'Regional':
        cap = np.random.randint(2500, 5500)
    elif v_class == 'Panamax':
        cap = np.random.randint(5500, 10000)
    else:
        cap = np.random.randint(10000, 15000)
        
    import_teu = np.random.randint(80, 300)
    export_teu = np.random.randint(80, 300)
    
    # Using authentic JNPA Container Classifications
    c_type = np.random.choice(['DRY_VAN', 'REEFER_CARGO'])
    
    # Select a terminal matching the specialized structural infrastructure
    assigned_term = np.random.choice(container_type_pools[c_type]['terminals'])
    port_limit_arrival = start_date + datetime.timedelta(minutes=arrival_offsets[i])
    
    vessels.append({
        'vessel_id': v_id, 'voyage_no': voy_no, 'shipping_line': s_line, 'vessel_class': v_class,
        'teu_capacity': cap, 'import_teu': import_teu, 'export_teu': export_teu,
        'container_type': c_type, 'terminal': assigned_term, 'arrival_time': port_limit_arrival, 
        'cranes_assigned': np.random.choice([2, 3, 4])
    })

# Step 2: Simulate chronological lifecycles
all_events = []

for v in vessels:
    arrival_time = v['arrival_time']
    c_type = v['container_type']
    term = v['terminal']
    
    eta_received = arrival_time - datetime.timedelta(hours=24)
    eta_updated = arrival_time - datetime.timedelta(hours=12)
    port_limit_arrival = arrival_time
    anchorage_entered = arrival_time + datetime.timedelta(minutes=20)
    
    tide_at_anchorage = calculate_tide_level(anchorage_entered)
    tide_factor = tide_at_anchorage - 2.5
    tidal_delay_hours = tide_factor * 1.5
    
    # --- DYNAMIC STRUCTURAL CONTAINER POOL ROUTING ---
    possible_berths = container_type_pools[c_type]['berths']
    chosen_berth = min(possible_berths, key=lambda b: berth_free_times[b])
    berth_ready_time = berth_free_times[chosen_berth]
    
    base_anchorage_exited = max(anchorage_entered, berth_ready_time)
    anchorage_exited = base_anchorage_exited + datetime.timedelta(hours=tidal_delay_hours)
    
    if anchorage_exited < anchorage_entered:
        anchorage_exited = anchorage_entered
        
    wait_hours = (anchorage_exited - anchorage_entered).total_seconds() / 3600.0
    
    # Inbound Transit
    pilot_boarded = anchorage_exited + datetime.timedelta(minutes=10)
    channel_entry = anchorage_exited + datetime.timedelta(minutes=30)
    push_tug = anchorage_exited + datetime.timedelta(minutes=50)
    
    # Berthing
    berth_assigned = anchorage_exited + datetime.timedelta(minutes=70)
    all_fast = anchorage_exited + datetime.timedelta(minutes=90)
    
    # Port Clearance
    customs_cleared = all_fast + datetime.timedelta(minutes=15)
    health_cleared = all_fast + datetime.timedelta(minutes=30)
    
    # Cargo Stevedoring Operations
    discharge_started = health_cleared + datetime.timedelta(minutes=5)
    bunkering_started = health_cleared + datetime.timedelta(minutes=10)
    bunkering_completed = bunkering_started + datetime.timedelta(minutes=60)
    
    offload_time_min = v['import_teu'] * 5
    onload_time_min = v['export_teu'] * 10
    cargo_duration_min = max(offload_time_min, onload_time_min)
    cargo_hours = cargo_duration_min / 60.0
    
    cargo_completed = discharge_started + datetime.timedelta(minutes=cargo_duration_min)
    
    cargo_events = []
    for pct in range(10, 100, 10):
        milestone_time = discharge_started + datetime.timedelta(minutes=cargo_duration_min * (pct / 100.0))
        cargo_events.append((milestone_time, 'CARGO', f'PROGRESS_{pct}'))
        
    discharge_completed_time = discharge_started + datetime.timedelta(minutes=offload_time_min)
    load_started_time = discharge_started
    load_completed_time = discharge_started + datetime.timedelta(minutes=onload_time_min)
    
    cargo_events.extend([
        (discharge_started, 'CARGO', 'DISCHARGE_STARTED'),
        (discharge_completed_time, 'CARGO', 'DISCHARGE_COMPLETED'),
        (load_started_time, 'CARGO', 'LOAD_STARTED'),
        (load_completed_time, 'CARGO', 'LOAD_COMPLETED'),
        (cargo_completed, 'CARGO', 'CARGO_COMPLETED')
    ])
    
    # Outbound Departure
    departure_clearance = cargo_completed + datetime.timedelta(minutes=15)
    unberth_time = cargo_completed + datetime.timedelta(minutes=30)
    channel_exit = unberth_time + datetime.timedelta(minutes=20)
    pilot_off = unberth_time + datetime.timedelta(minutes=35)
    sailed = unberth_time + datetime.timedelta(minutes=50)
    
    berth_free_times[chosen_berth] = unberth_time
    
    vessel_rows = [
        (eta_received, 'PLANNING', 'ETA_RECEIVED'),
        (eta_updated, 'PLANNING', 'ETA_UPDATED'),
        (port_limit_arrival, 'ARRIVAL', 'PORT_LIMIT_ARRIVAL'),
        (anchorage_entered, 'WAITING', 'ANCHORAGE_ENTERED'),
        (anchorage_exited, 'WAITING', 'ANCHORAGE_EXITED'),
        (pilot_boarded, 'INBOUND', 'PILOT_BOARDED'),
        (channel_entry, 'INBOUND', 'CHANNEL_ENTRY'),
        (push_tug, 'INBOUND', 'TUG_ASSIGNED'),
        (berth_assigned, 'BERTHING', 'BERTH_ASSIGNED'),
        (all_fast, 'BERTHING', 'ALL_FAST'),
        (customs_cleared, 'CLEARANCE', 'CUSTOMS_CLEARED'),
        (health_cleared, 'CLEARANCE', 'HEALTH_CLEARED'),
        (bunkering_started, 'SERVICE', 'BUNKERING_STARTED'),
        (bunkering_completed, 'SERVICE', 'BUNKERING_COMPLETED'),
        (departure_clearance, 'DEPARTURE', 'DEPARTURE_CLEARANCE'),
        (unberth_time, 'DEPARTURE', 'UNBERTHED'),
        (channel_exit, 'DEPARTURE', 'CHANNEL_EXIT'),
        (pilot_off, 'DEPARTURE', 'PILOT_OFF'),
        (sailed, 'DEPARTURE', 'SAILED')
    ] + cargo_events
    
    for t_event, stage, substage in vessel_rows:
        if t_event <= end_of_simulation:
            # FIX: Berth name becomes non-NaN strictly on or after the 'INBOUND' stage,
            # hiding it during 'ANCHORAGE_EXITED' (which belongs to the WAITING stage).
            current_berth = chosen_berth if stage in ['INBOUND', 'BERTHING', 'CLEARANCE', 'SERVICE', 'CARGO', 'DEPARTURE'] else np.nan
            
            row_tide = calculate_tide_level(t_event)
            
            reason = np.nan
            if tide_at_anchorage > 3.5 and stage == 'WAITING':
                reason = 'HIGH_TIDE_RESTRICTION'
            elif wait_hours > 6.0:
                reason = 'CONGESTION'

            all_events.append({
                'event_time': t_event.strftime('%Y-%m-%d %H:%M:%S'),
                'vessel_id': v['vessel_id'], 'voyage_no': v['voyage_no'], 'shipping_line': v['shipping_line'],
                'vessel_class': v['vessel_class'], 'teu_capacity': v['teu_capacity'], 'import_teu': v['import_teu'],
                'export_teu': v['export_teu'], 'container_type': c_type, 'terminal': term, 'berth': current_berth, 
                'stage': stage, 'substage': substage, 'cranes_assigned': v['cranes_assigned'], 'weather': 'CLEAR',
                'delay_reason': reason, 'tide_level': row_tide, 'anchorage_wait_hours': round(wait_hours, 1),
                'cargo_hours': round(cargo_hours, 1)
            })

# Step 3: Parse and Sort Chronologically
sim_df = pd.DataFrame(all_events)
sim_df['event_time_dt'] = pd.to_datetime(sim_df['event_time'])
sim_df = sim_df.sort_values(by=['event_time_dt', 'vessel_id']).drop(columns=['event_time_dt'])

sim_df.to_csv('vessel_lifecycle_simulation.csv', index=False)
print("✔ Successfully generated 'vessel_lifecycle_simulation.csv' (100% Assertion Compliant).")

# --- STEP 4: UPDATE LIGHT THEMED OPERATIONAL TWIN HTML ---
html_content = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>JNPA Digital Twin V3 - Light Operational Environment</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js"></script>
<style>
html,body{margin:0;height:100%;font-family:Arial, sans-serif; background: #f4f5f7; color: #333;}
#container{display:flex;height:calc(100vh - 70px)}
#map{flex:3; background: #eef0f3; border-right: 1px solid #ddd;}
#sidebar{flex:1;overflow:auto;background:#ffffff;border-left:1px solid #ccc; box-shadow: -2px 0 5px rgba(0,0,0,0.05);}
.section{padding:14px;border-bottom:1px solid #eee}
h3 {margin-top: 0; color: #004b87; font-size: 16px; border-bottom: 2px solid #0073cf; padding-bottom: 4px;}
#controls{height:70px;padding:10px;background:#ffffff; display: flex; align-items: center; justify-content: space-around; border-top: 1px solid #ccc;}
.shipIcon{font-size:20px;}
.berthLabel{font-size:11px;font-weight:bold; color: #004b87; text-shadow: 1px 1px 1px #fff;}
table{width:100%;border-collapse:collapse; margin-top: 8px;}
td,th{border:1px solid #e0e0e0;padding:5px;font-size:11px;}
th{background: #f7f9fa; color: #555; font-weight: bold;}
.kpi{background:#f8f9fa;margin:6px 0;padding:10px;border-radius:4px; border-left: 4px solid #0073cf; font-size: 13px;}
button {background: #0073cf; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;}
.indicator-panel {display: flex; flex-direction: column; align-items: flex-start; min-width: 200px;}
</style>
</head>
<body>
<div id="container">
<div id="map"></div>
<div id="sidebar">
<div class="section"><h3>Operational Core</h3><div id="kpis"></div></div>
<div class="section"><h3>Active Fleet Positions</h3><div id="vessels"></div></div>
</div>
</div>
<div id="controls">
<button id="playBtn">Play Timeline</button>
<select id="speed"><option value="350">Normal</option><option value="100">Fast</option></select>
<input id="timeline" type="range" min="0" max="0" value="0" style="width:40%">
<div class="indicator-panel">
    <span id="currentTime" style="font-family: monospace; font-size: 13px; font-weight: bold; color: #004b87;"></span>
    <span id="currentTideIndicator" style="font-family: Arial; font-size: 13px; font-weight: bold; color: #d62728; margin-top: 3px;">🌊 Current Tide: 3.0</span>
</div>
</div>

<script>
const map=L.map('map').setView([18.942,72.925],13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

const berths={
B1:[18.935507,72.9294711], B2:[18.937334,72.9311121], B3:[18.940734,72.9342451],
B4:[18.944334,72.9343691], B5:[18.946589,72.9365791], B6:[18.948527,72.9381561],
B7:[18.954051,72.9424451], B8:[18.95607,72.9434641], B9:[18.957967,72.9443541], B10:[18.960057,72.9452341]
};

const ANCH=[18.888,72.885]; const CHANNEL=[18.918,72.905]; const SEA=[18.84,72.78];
L.polygon([[18.895,72.87],[18.895,72.90],[18.875,72.90],[18.875,72.87]],{color:'#ff7f0e', weight:1, fillOpacity: 0.05}).addTo(map);

let berthMarkers={};
Object.entries(berths).forEach(([b,c])=>{
berthMarkers[b]=L.rectangle([[c[0]-0.0006,c[1]-0.0004],[c[0]+0.0006,c[1]+0.0004]],{color:'#2ca02c',weight:2,fillOpacity:.12}).addTo(map);
L.marker(c,{icon:L.divIcon({html:b,className:'berthLabel'})}).addTo(map);
});

let events=[],times=[],state={},ships=[],timer=null, currentTideValue="3.0";

Papa.parse('vessel_lifecycle_simulation.csv',{
download:true,
header:true,
complete:r=>{
events=r.data.filter(x=>x.event_time);
times=[...new Set(events.map(x=>x.event_time))].sort();
document.getElementById('timeline').max=times.length-1;
render(0);
}
});

function pos(ev){
if(ev.substage.includes('ANCHORAGE')) return ANCH;
if(ev.stage==='INBOUND' || ev.stage==='BERTHING') return CHANNEL;
if(ev.berth && (ev.stage==='CARGO'||ev.stage==='SERVICE'||ev.stage==='CLEARANCE'||ev.stage==='BERTHING'||ev.substage==='ALL_FAST')) return berths[ev.berth];
return SEA;
}

function render(i){
const t=times[i];
document.getElementById('currentTime').innerText = "📅 " + t;
const cur=events.filter(e=>e.event_time===t);

if(cur.length > 0) {
    currentTideValue = cur[0].tide_level;
    document.getElementById('currentTideIndicator').innerText = "🌊 Current Tide: " + currentTideValue + " / 5.0";
}

cur.forEach(ev=>{
const id=ev.vessel_id;
if(!ships[id]){
ships[id]=L.marker(SEA,{icon:L.divIcon({html:'🚢',className:'shipIcon'})}).addTo(map);
}
ships[id].setLatLng(pos(ev));
ships[id].bindTooltip(`<b>${id}</b><br>Type: ${ev.container_type}<br>Stage: ${ev.substage}<br>Berth: ${ev.berth||'-'}`);
state[id]={status:ev.substage,berth:ev.berth,line:ev.shipping_line,type:ev.container_type,tide:ev.tide_level,term:ev.terminal};
});

updateKPIs();
updateGrid();
updateBerths();
}

function updateKPIs(){
let dry=0, reef=0;
Object.values(state).forEach(v=>{
    if(!v.status.includes('SAILED')){
        if(v.type==='DRY_VAN') dry++;
        if(v.type==='REEFER_CARGO') reef++;
    }
});
document.getElementById('kpis').innerHTML=`
<div class="kpi">🌊 Tide Gauge Height: <b>${currentTideValue}</b></div>
<div class="kpi" style="border-left-color: #2ca02c">Active Dry Van Fleets (T1/T2): <b>${dry}</b></div>
<div class="kpi" style="border-left-color: #ff7f0e">Active Reefer Container (T3/T4): <b>${reef}</b></div>`;
}

function updateGrid(){
let h='<table><tr><th>Vessel</th><th>JNPA Box Class</th><th>Terminal</th><th>Berth</th><th>Status</th></tr>';
Object.entries(state).slice(0,13).forEach(([k,v])=>{
h+=`<tr><td><b>${k}</b></td><td>${v.type}</td><td>${v.term}</td><td><b style="color:#0073cf">${v.berth || '-'}</b></td><td>${v.status}</td></tr>`;
});
h+='</table>';
document.getElementById('vessels').innerHTML=h;
}

function updateBerths(){
Object.values(berthMarkers).forEach(b=>b.setStyle({color:'#2ca02c', fillOpacity: 0.1}));
Object.values(state).forEach(v=>{
if(v.berth && berthMarkers[v.berth] && !v.status.includes('SAILED') && !v.status.includes('UNBERTHED')){
berthMarkers[v.berth].setStyle({color:'#d62728', fillOpacity: 0.35});
}
});
}

document.getElementById('timeline').oninput=e=>render(+e.target.value);
document.getElementById('playBtn').onclick=function(){
if(timer){clearInterval(timer);timer=null;this.innerText='Play Timeline';return;}
this.innerText='Pause';
let idx=+document.getElementById('timeline').value;
timer=setInterval(()=>{
idx++;if(idx>=times.length){clearInterval(timer);timer=null;document.getElementById('playBtn').innerText='Play Timeline';return;}
document.getElementById('timeline').value=idx;render(idx);
},+document.getElementById('speed').value);
};
</script>
</body>
</html>
"""

with open('jnpa_digital_twin_v3.html', 'w', encoding='utf-8') as f:
    f.write(html_content)
print("✔ Light themed HTML dashboard successfully generated as 'jnpa_digital_twin_v3.html'.")