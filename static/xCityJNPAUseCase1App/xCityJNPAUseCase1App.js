
/*global widget, define */
define('xCityJNPAUseCase1App', [
    'UWA/Core',
    'UWA/Promise',
    'UWA/String',
    'DS/WAFData/WAFData',
    'DS/PlatformAPI/PlatformAPI',
    'DS/UIKIT/Toggler',
    'DS/UIKIT/Autocomplete',
    'DS/UIKIT/Input/Button',
    'DS/UIKIT/Scroller',
    'css!DS/UIKIT/UIKIT.css'
], function (UWA, Promise, String, WAFData, PlatformAPI){
    'use strict';

    var JSON_URL = 'https://test-app-lyart-six.vercel.app/static/xCityJNPAUseCase1App/usecase1_predictions.json';

    // 2. Initialize DATA as an empty array
    var DATA = [];
    var BERTH_POINTS = {
        BMCT01: {lon:72.9506, lat:18.9488, terminal:'BMCT'},
        BMCT02: {lon:72.9524, lat:18.9498, terminal:'BMCT'},
        NSICT01: {lon:72.9572, lat:18.9508, terminal:'NSICT'},
        NSICT02: {lon:72.9586, lat:18.9516, terminal:'NSICT'},
        NSIGT01: {lon:72.9610, lat:18.9544, terminal:'NSIGT'},
        GTI01: {lon:72.9660, lat:18.9593, terminal:'GTI'},
        JNPCT01: {lon:72.9690, lat:18.9620, terminal:'JNPCT'},
        NSFT01: {lon:72.9704, lat:18.9632, terminal:'NSFT'}
    };
    var TERMINAL_POINTS = {
        BMCT: {lon:72.9515, lat:18.9493},
        NSICT: {lon:72.9579, lat:18.9512},
        NSIGT: {lon:72.9610, lat:18.9544},
        GTI: {lon:72.9660, lat:18.9593},
        JNPCT: {lon:72.9690, lat:18.9620},
        NSFT: {lon:72.9704, lat:18.9632}
    };
    var BASELINE = {
        eta: 48,
        pre: 110,
        service: 780,
        tat: 1020,
        pressure: 1.15,
        conflictPct: 28
    };

    var state = {
        terminal: 'ALL',
        berth: 'ALL',
        line: 'ALL',
        scenario: {
            etaShift: 0,
            berthUnavailable: 'NONE',
            yardMultiplier: 1.00,
            gateMultiplier: 1.00,
            weatherMultiplier: 1.00,
            pilotAvailable: 1,
            tugAvailable: 1
        },
        ui: {}
    };

    // 3. Function to fetch the ML predictions
    function loadModelData() {
        return new Promise(function (resolve, reject) {
            WAFData.proxifiedRequest(JSON_URL, {
                method: 'GET',
                type: 'json',
                onComplete: function (response) {
                    DATA = response; // Populate the global DATA array
                    resolve();
                },
                onFailure: function (error) {
                    reject(error);
                }
            });
        });
    }

    function onLoad() {
        loadModelData().then(function() {
            console.log("Successfully loaded " + DATA.length + " rows from XGBoost model.");
            
            // Build the UI and render only AFTER data is populated
            buildUI();
            render();
            
        }).catch(function(err) {
            console.error("Failed to load ML predictions JSON.", err);
        });
    }

    widget.addEvent('onLoad', onLoad);
    

    function n(v) { var x = parseFloat(v); return isNaN(x) ? 0 : x; }
    function avg(arr) { return arr.length ? arr.reduce(function(a,b){return a+n(b);},0)/arr.length : 0; }
    function sum(arr) { return arr.reduce(function(a,b){return a+n(b);},0); }
    function fmt(v,d) { return Number(v).toFixed(d || 1); }
    function improve(b, c) { return ((b-c)/b)*100; }
    function uniq(arr) { return Array.from(new Set(arr)); }
    function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function groupBy(arr, keyFn) {
        var m = {};
        arr.forEach(function(r) {
            var k = keyFn(r);
            if (!m[k]) m[k] = [];
            m[k].push(r);
        });
        return m;
    }

    function scenarioRow(r) {
        var s = state.scenario;
        var o = JSON.parse(JSON.stringify(r));
        var weather = n(r.weather_risk_index) * s.weatherMultiplier;
        var yard = n(r.yard_congestion_index) * s.yardMultiplier;
        var gate = n(r.gate_congestion_index) * s.gateMultiplier;
        var pilot = s.pilotAvailable;
        var tug = s.tugAvailable;
        var berthBlocked = s.berthUnavailable !== 'NONE' && r.candidate_berth === s.berthUnavailable ? 1 : 0;

        o.eta_deviation_min = n(r.eta_deviation_min) + s.etaShift * 60 + weather * 10;
        o.pre_berthing_delay_min = Math.max(0,
            n(r.pre_berthing_delay_min) + weather * 18 + yard * 8 + gate * 6 +
            (pilot ? 0 : 35) + (tug ? 0 : 28) + (berthBlocked ? 70 : 0)
        );
        o.service_time_min = Math.max(120,
            n(r.service_time_min) + yard * 30 + gate * 20 + (pilot ? 0 : 10) + (tug ? 0 : 10)
        );
        o.vessel_turnaround_min = o.eta_deviation_min + o.pre_berthing_delay_min + o.service_time_min + 120;
        o.berth_pressure_index = Math.min(1.8,
            n(r.berth_pressure_index) + yard * 0.12 + gate * 0.08 +
            (pilot ? 0 : 0.10) + (tug ? 0 : 0.08) + (berthBlocked ? 0.25 : 0)
        );
        o.berth_conflict_prob = Math.min(0.99,
            (n(r.berth_conflict_flag) ? 0.68 : 0.18) +
            Math.max(0, o.berth_pressure_index - 1.0) * 0.35 +
            (berthBlocked ? 0.22 : 0) + (pilot ? 0 : 0.08) + (tug ? 0 : 0.06)
        );
        o.berth_conflict_flag = o.berth_conflict_prob >= 0.5 ? 1 : 0;
        return o;
    }

    function filteredRows() {
        return DATA
            .filter(function(r) { return state.terminal === 'ALL' || r.terminal_code === state.terminal; })
            .filter(function(r) { return state.berth === 'ALL' || r.candidate_berth === state.berth; })
            .filter(function(r) { return state.line === 'ALL' || r.shipping_line === state.line; })
            .map(scenarioRow);
    }

    function byMonthRollup(rows) {
        var g = groupBy(rows, function(r) { return r.month + '-' + r.terminal_code; });
        var out = [];
        Object.keys(g).forEach(function(k) {
            var arr = g[k];
            out.push({
                key: k,
                month: n(arr[0].month),
                terminal: arr[0].terminal_code,
                eta: avg(arr.map(function(r) { return r.eta_deviation_min; })),
                pre: avg(arr.map(function(r) { return r.pre_berthing_delay_min; })),
                service: avg(arr.map(function(r) { return r.service_time_min; })),
                tat: avg(arr.map(function(r) { return r.vessel_turnaround_min; })),
                pressure: avg(arr.map(function(r) { return r.berth_pressure_index; })),
                conflict: avg(arr.map(function(r) { return r.berth_conflict_flag; })) * 100
            });
        });
        out.sort(function(a,b) { return a.month - b.month; });
        return out;
    }

    function recommendations(rows) {
        var recos = [];
        var eta = avg(rows.map(function(r) { return r.eta_deviation_min; }));
        var pre = avg(rows.map(function(r) { return r.pre_berthing_delay_min; }));
        var service = avg(rows.map(function(r) { return r.service_time_min; }));
        var pressure = avg(rows.map(function(r) { return r.berth_pressure_index; }));
        var conflict = avg(rows.map(function(r) { return r.berth_conflict_flag; })) * 100;

        if (pre > 95) recos.push('Increase berth-window coordination and reduce pilot/tug contention during clustered arrival windows.');
        if (pressure > 1.12) recos.push('Advance berth forecasting and pre-rank alternate feasible berths for high-pressure windows.');
        if (conflict > 20) recos.push('Use AI conflict scores to trigger proactive berth reassignment before overlap risk rises.');
        if (service > 760) recos.push('Improve crane allocation and downstream yard/gate evacuation readiness to shorten service duration.');
        if (eta > 40) recos.push('Apply arrival reliability monitoring by shipping line and tighten ETA confidence scoring.');
        if (!recos.length) recos.push('Marine operating state remains stable. Maintain current berth sequencing and resource readiness.');
        return recos;
    }

    function kpiCard(label, current, baselineVal, unit) {
        var imp = improve(baselineVal, current);
        var color = imp >= 20 ? '#0f766e' : imp >= 8 ? '#d97706' : '#b91c1c';
        var box = UWA.createElement('div', {
            styles: {
                padding: '10px 12px',
                background: '#eef3f7',
                borderRadius: '10px',
                minHeight: '84px'
            }
        });
        UWA.createElement('div', { text: label, styles: { fontSize: '12px', color: '#6a7a8c', fontWeight: '700' } }).inject(box);
        UWA.createElement('div', { text: fmt(current,1) + ' ' + unit, styles: { fontSize: '22px', fontWeight: '700', marginTop: '6px', color: '#17324d' } }).inject(box);
        UWA.createElement('div', { html: 'Baseline: ' + baselineVal + ' ' + unit + '<br/>Improvement: <span style="color:' + color + ';font-weight:700;">' + fmt(imp,2) + '%</span>', styles: { fontSize: '12px', color: '#6a7a8c', marginTop: '6px' } }).inject(box);
        return box;
    }

    function miniBars(title, labels, values, color) {
        var max = 1;
        values.forEach(function(v) { max = Math.max(max, n(v)); });
        var bars = labels.map(function(l, i) {
            var h = Math.max(8, Math.round((n(values[i]) / max) * 90));
            return '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;">' +
                   '<div title="' + esc(l) + ': ' + esc(fmt(values[i],1)) + '" style="width:18px;height:' + h + 'px;background:' + color + ';border-radius:4px 4px 0 0;"></div>' +
                   '<div style="font-size:10px;color:#667;white-space:nowrap;">' + esc(l) + '</div></div>';
        }).join('');
        return '<div style="border:1px solid #dde3ec;border-radius:10px;padding:10px;background:#fff;">' +
               '<div style="font-size:12px;color:#6a7a8c;font-weight:700;margin-bottom:8px;">' + esc(title) + '</div>' +
               '<div style="display:flex;align-items:flex-end;gap:10px;height:120px;">' + bars + '</div></div>';
    }

    function scatterHtml(title, points, xLabel, yLabel, color) {
        var W = 520, H = 220, P = 30;
        var maxX = 1, maxY = 1;
        points.forEach(function(p) { maxX = Math.max(maxX, n(p.x)); maxY = Math.max(maxY, n(p.y)); });
        var dots = points.map(function(p) {
            var x = P + (n(p.x)/maxX) * (W-P*2);
            var y = H-P - (n(p.y)/maxY) * (H-P*2);
            return '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + color + '" opacity="0.72"><title>' + esc(p.label) + '</title></circle>';
        }).join('');
        return '<div style="border:1px solid #dde3ec;border-radius:10px;padding:10px;background:#fff;">' +
               '<div style="font-size:12px;color:#6a7a8c;font-weight:700;margin-bottom:8px;">' + esc(title) + '</div>' +
               '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:220px;">' +
               '<line x1="' + P + '" y1="' + (H-P) + '" x2="' + (W-P) + '" y2="' + (H-P) + '" stroke="#cfd8e3"/>' +
               '<line x1="' + P + '" y1="' + P + '" x2="' + P + '" y2="' + (H-P) + '" stroke="#cfd8e3"/>' +
               dots +
               '<text x="' + (W/2) + '" y="' + (H-6) + '" font-size="11" fill="#6a7a8c" text-anchor="middle">' + esc(xLabel) + '</text>' +
               '<text x="14" y="' + (H/2) + '" font-size="11" fill="#6a7a8c" text-anchor="middle" transform="rotate(-90 14,' + (H/2) + ')">' + esc(yLabel) + '</text>' +
               '</svg></div>';
    }

    function publishCityMarkers(rows) {
        try {
            PlatformAPI.publish('3DEXPERIENCity.RemoveContent', 'JNPA_USECASE1_BERTHS');
        } catch (e) {}
        try {
            PlatformAPI.publish('3DEXPERIENCity.RemoveContent', 'JNPA_USECASE1_TERMINALS');
        } catch (e) {}

        var berthAgg = groupBy(rows, function(r) { return r.candidate_berth; });
        Object.keys(berthAgg).forEach(function(berth) {
            if (!BERTH_POINTS[berth]) return;
            var arr = berthAgg[berth];
            var pressure = avg(arr.map(function(r) { return r.berth_pressure_index; }));
            var conflict = avg(arr.map(function(r) { return r.berth_conflict_flag; })) * 100;
            var color = pressure > 1.25 || conflict > 25 ? '#C62828' : pressure > 1.05 || conflict > 15 ? '#EF6C00' : '#2E7D32';
            var pt = BERTH_POINTS[berth];

            PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
                widgetID: widget.id,
                position: { x: pt.lon, y: pt.lat },
                layer: {
                    id: 'BERTH_' + berth,
                    name: berth,
                    description: '<b>Berth:</b> ' + esc(berth) + '<br/><b>Terminal:</b> ' + esc(pt.terminal) + '<br/><b>Pressure:</b> ' + esc(fmt(pressure,2)) + '<br/><b>Conflict:</b> ' + esc(fmt(conflict,1)) + '%'
                },
                render: {
                    style: 'icon',
                    color: color,
                    iconName: 'anchor'
                },
                options: {
                    projection: { from: 'WGS84' }
                }
            });
        });

        Object.keys(TERMINAL_POINTS).forEach(function(term) {
            var arr = rows.filter(function(r) { return r.terminal_code === term; });
            if (!arr.length) return;
            var tat = avg(arr.map(function(r) { return r.vessel_turnaround_min; }));
            var eta = avg(arr.map(function(r) { return r.eta_deviation_min; }));
            var color = tat > 1100 || eta > 55 ? '#C62828' : tat > 950 || eta > 40 ? '#EF6C00' : '#2E7D32';
            var pt = TERMINAL_POINTS[term];
            PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
                widgetID: widget.id,
                position: { x: pt.lon, y: pt.lat },
                layer: {
                    id: 'TERM_' + term,
                    name: term,
                    description: '<b>Terminal:</b> ' + esc(term) + '<br/><b>Avg ETA dev:</b> ' + esc(fmt(eta,1)) + ' min<br/><b>Avg turnaround:</b> ' + esc(fmt(tat,1)) + ' min'
                },
                render: {
                    style: 'icon',
                    color: color,
                    iconName: 'transportation-ship'
                },
                options: {
                    projection: { from: 'WGS84' }
                }
            });
        });
    }

    function render() {
        var rows = filteredRows();
        var monthly = byMonthRollup(rows);
        var current = {
            eta: avg(rows.map(function(r) { return r.eta_deviation_min; })),
            pre: avg(rows.map(function(r) { return r.pre_berthing_delay_min; })),
            service: avg(rows.map(function(r) { return r.service_time_min; })),
            tat: avg(rows.map(function(r) { return r.vessel_turnaround_min; })),
            pressure: avg(rows.map(function(r) { return r.berth_pressure_index; })),
            conflict: avg(rows.map(function(r) { return r.berth_conflict_flag; })) * 100
        };
        var recos = recommendations(rows);

        state.ui.content.empty();

        var summary = UWA.createElement('div', { styles: { display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:'8px', marginBottom:'12px' } }).inject(state.ui.content);
        kpiCard('ETA Deviation', current.eta, BASELINE.eta, 'min').inject(summary);
        kpiCard('Pre-Berthing Delay', current.pre, BASELINE.pre, 'min').inject(summary);
        kpiCard('Service Time', current.service, BASELINE.service, 'min').inject(summary);
        kpiCard('Turnaround', current.tat, BASELINE.tat, 'min').inject(summary);
        kpiCard('Berth Pressure', current.pressure, BASELINE.pressure, 'idx').inject(summary);
        kpiCard('Conflict Rate', current.conflict, BASELINE.conflictPct, '%').inject(summary);

        var tabsBox = UWA.createElement('div', { styles: { display:'grid', gridTemplateColumns:'1.2fr 1fr', gap:'12px', marginBottom:'12px' } }).inject(state.ui.content);

        var left = UWA.createElement('div').inject(tabsBox);
        var right = UWA.createElement('div').inject(tabsBox);

        UWA.createElement('div', {
            html: miniBars('ETA deviation by month', monthly.map(function(m) { return 'M' + m.month; }), monthly.map(function(m) { return m.eta; }), '#2563eb'),
            styles: { marginBottom:'10px' }
        }).inject(left);
        UWA.createElement('div', {
            html: miniBars('Berth pressure by month', monthly.map(function(m) { return 'M' + m.month; }), monthly.map(function(m) { return m.pressure; }), '#b91c1c'),
            styles: { marginBottom:'10px' }
        }).inject(left);

        var byBerth = Object.keys(groupBy(rows, function(r) { return r.candidate_berth; })).map(function(k) {
            var arr = rows.filter(function(r) { return r.candidate_berth === k; });
            return {
                berth: k,
                pressure: avg(arr.map(function(r) { return r.berth_pressure_index; })),
                conflict: avg(arr.map(function(r) { return r.berth_conflict_flag; })) * 100
            };
        }).sort(function(a,b) { return b.pressure - a.pressure; });

        UWA.createElement('div', {
            html: miniBars('Conflict rate by berth', byBerth.map(function(r) { return r.berth; }), byBerth.map(function(r) { return r.conflict; }), '#d97706'),
            styles: { marginBottom:'10px' }
        }).inject(right);

        var points = rows.slice(0, 350).map(function(r) {
            return { x: n(r.total_moves), y: n(r.service_time_min), label: r.vessel_id + ' | ' + r.candidate_berth };
        });
        UWA.createElement('div', {
            html: scatterHtml('Moves vs service time', points, 'Import + Export moves', 'Service time', '#0f766e')
        }).inject(right);

        var bottom = UWA.createElement('div', { styles: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px' } }).inject(state.ui.content);
        var recCard = UWA.createElement('div', { styles: { border:'1px solid #dde3ec', borderRadius:'10px', padding:'10px', background:'#fff' } }).inject(bottom);
        UWA.createElement('div', { text: 'AI Recommendations', styles: { fontSize:'12px', color:'#6a7a8c', fontWeight:'700', marginBottom:'8px' } }).inject(recCard);
        recos.forEach(function(r) {
            UWA.createElement('div', {
                text: r,
                styles: { padding:'10px', borderLeft:'4px solid #2563eb', background:'#f8fbff', borderRadius:'8px', marginBottom:'8px', fontSize:'13px' }
            }).inject(recCard);
        });

        var tableCard = UWA.createElement('div', { styles: { border:'1px solid #dde3ec', borderRadius:'10px', padding:'10px', background:'#fff' } }).inject(bottom);
        UWA.createElement('div', { text: 'Highest conflict-risk vessel calls', styles: { fontSize:'12px', color:'#6a7a8c', fontWeight:'700', marginBottom:'8px' } }).inject(tableCard);
        var topRisk = rows.slice().sort(function(a,b) { return b.berth_conflict_prob - a.berth_conflict_prob; }).slice(0, 12);
        var tableHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#fafcff;"><th style="padding:8px;border-bottom:1px solid #dde3ec;text-align:left;">Vessel</th><th style="padding:8px;border-bottom:1px solid #dde3ec;text-align:left;">Berth</th><th style="padding:8px;border-bottom:1px solid #dde3ec;text-align:left;">Terminal</th><th style="padding:8px;border-bottom:1px solid #dde3ec;text-align:left;">Conflict Prob.</th></tr></thead><tbody>';
        topRisk.forEach(function(r) {
            tableHtml += '<tr><td style="padding:8px;border-bottom:1px solid #dde3ec;">' + esc(r.vessel_name) + '</td><td style="padding:8px;border-bottom:1px solid #dde3ec;">' + esc(r.candidate_berth) + '</td><td style="padding:8px;border-bottom:1px solid #dde3ec;">' + esc(r.terminal_code) + '</td><td style="padding:8px;border-bottom:1px solid #dde3ec;">' + esc(fmt(r.berth_conflict_prob * 100,1)) + '%</td></tr>';
        });
        tableHtml += '</tbody></table>';
        UWA.createElement('div', { html: tableHtml }).inject(tableCard);

        state.ui.status.setText('Widget ready. Rows in current filter: ' + rows.length + '. Markers published to City.');
        publishCityMarkers(rows);
    }

    function buildUI() {
        widget.body.empty();
        var wrap = UWA.createElement('div', { styles: { padding:'12px', fontFamily:'Arial,sans-serif', background:'#f5f7fb' } }).inject(widget.body);

        UWA.createElement('h1', {
            text: 'JNPA Use Case 1 – Vessel & Berth AI Analytics',
            styles: { color:'#0B5CAB', fontSize:'20px', margin:'0 0 6px 0' }
        }).inject(wrap);
        UWA.createElement('div', {
            text: '3DEXPERIENCE City widget with berth and terminal markers for deployment.',
            styles: { color:'#6a7a8c', marginBottom:'10px' }
        }).inject(wrap);

        state.ui.status = UWA.createElement('div', {
            text: 'Initializing widget and City markers…',
            styles: { padding:'10px', borderRadius:'8px', background:'#eef3f7', marginBottom:'12px', fontSize:'13px' }
        }).inject(wrap);

        var controls = UWA.createElement('div', {
            styles: { display:'grid', gridTemplateColumns:'220px 220px 220px 1fr', gap:'10px', marginBottom:'12px' }
        }).inject(wrap);

        var terminalSelect = UWA.createElement('select').inject(UWA.createElement('div', { html:'<label style="font-size:12px;color:#6a7a8c;font-weight:700;">Terminal</label>' }).inject(controls));
        var berthSelect = UWA.createElement('select').inject(UWA.createElement('div', { html:'<label style="font-size:12px;color:#6a7a8c;font-weight:700;">Berth</label>' }).inject(controls));
        var lineSelect = UWA.createElement('select').inject(UWA.createElement('div', { html:'<label style="font-size:12px;color:#6a7a8c;font-weight:700;">Shipping line</label>' }).inject(controls));
        var infoBox = UWA.createElement('div', {
            html: '<div style="font-size:12px;color:#6a7a8c;font-weight:700;">Scenario controls</div>' +
                  '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;">' +
                  '<div><label style="font-size:11px;color:#6a7a8c;">ETA shift</label><input id="etaShift" type="range" min="-6" max="6" step="1" value="0"/></div>' +
                  '<div><label style="font-size:11px;color:#6a7a8c;">Yard x</label><input id="yardMul" type="range" min="0.7" max="1.5" step="0.05" value="1"/></div>' +
                  '<div><label style="font-size:11px;color:#6a7a8c;">Gate x</label><input id="gateMul" type="range" min="0.7" max="1.5" step="0.05" value="1"/></div>' +
                  '</div>',
            styles: { border:'1px solid #dde3ec', borderRadius:'10px', padding:'10px', background:'#fff' }
        }).inject(controls);

        var terminals = ['ALL'].concat(uniq(DATA.map(function(r) { return r.terminal_code; })));
        terminalSelect.setHTML(terminals.map(function(v) { return '<option value="' + v + '">' + v + '</option>'; }).join(''));
        terminalSelect.addEvent('change', function(e) { state.terminal = e.target.value; render(); });

        var berths = ['ALL'].concat(uniq(DATA.map(function(r) { return r.candidate_berth; })));
        berthSelect.setHTML(berths.map(function(v) { return '<option value="' + v + '">' + v + '</option>'; }).join(''));
        berthSelect.addEvent('change', function(e) { state.berth = e.target.value; render(); });

        var lines = ['ALL'].concat(uniq(DATA.map(function(r) { return r.shipping_line; })));
        lineSelect.setHTML(lines.map(function(v) { return '<option value="' + v + '">' + v + '</option>'; }).join(''));
        lineSelect.addEvent('change', function(e) { state.line = e.target.value; render(); });

        infoBox.getElement('#etaShift').addEvent('input', function(e) { state.scenario.etaShift = parseFloat(e.target.value); render(); });
        infoBox.getElement('#yardMul').addEvent('input', function(e) { state.scenario.yardMultiplier = parseFloat(e.target.value); render(); });
        infoBox.getElement('#gateMul').addEvent('input', function(e) { state.scenario.gateMultiplier = parseFloat(e.target.value); render(); });

        state.ui.content = UWA.createElement('div').inject(wrap);
    }


    return state;
});