/*global window, widget, define*/

define('VesselSystem',
[
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
],

function (UWA, Promise, String, WAFData, PlatformAPI) {

    'use strict';

    var CONFIG = {
        CSV_URL: 'https://test-app-lyart-six.vercel.app/static/VesselSystem/jnpa_vessel_timeseries.csv',
        // Update this URL to exactly match the name of the PNG you upload to Vercel!
        CUSTOM_ICON_URL: 'https://test-app-lyart-six.vercel.app/static/VesselSystem/custom_boat.png', 
        PLAYBACK_INTERVAL_MS: 3000,
        TRAIL_LENGTH: 10,
        MARKER_PREFIX: 'VESSEL_',
        TRAIL_PREFIX: 'TRAIL_'
    };

    var app = {
        frames: [],
        frameIndex: 0,
        byVessel: {}, 
        activeMarkerIds: [],
        activeTrailIds: [],
        selectedShipId: null,
        playbackHandle: null,
        container: null,
        statusBar: null,
        trails: {}
    };

    function safe(v) { return (v === undefined || v === null || v === '') ? '-' : String(v); }

    function esc(s) {
        return safe(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function formatKey(key) {
        if (!key) return '';
        key = key.replace(/_/g, ' ');
        return key.charAt(0).toUpperCase() + key.slice(1);
    }

    // Dynamic Color Logic
    function getVesselStage(ship) {
        var text = ((ship.remarks || '') + ' ' + (ship.route_segment || '')).toLowerCase();

        if (text.indexOf('moor') !== -1 || text.indexOf('secure') !== -1 || text.indexOf('adjust') !== -1 || text.indexOf('berth') !== -1) {
            return { label: 'Berthing / Moored', color: '#3498DB' }; 
        }
        if (text.indexOf('outbound') !== -1 || text.indexOf('depart') !== -1 || text.indexOf('leave') !== -1) {
            return { label: 'Departing / Outbound', color: '#E67E22' }; 
        }
        if (text.indexOf('inbound') !== -1 || text.indexOf('enter') !== -1 || text.indexOf('approach') !== -1) {
            return { label: 'Arriving / Inbound', color: '#2ECC71' }; 
        }
        return { label: 'In Transit', color: '#9B59B6' }; 
    }

    function apiGetText(url) {
        return new Promise(function (resolve, reject) {
            WAFData.proxifiedRequest(url, {
                method: 'GET',
                type: 'text',
                onComplete: resolve,
                onFailure: function (e, d) { reject(d || e); }
            });
        });
    }

    function parseCsv(text) {
        var lines = text.replace(/\r/g, '').trim().split('\n');
        if (!lines.length) { return []; }
        var headers = lines[0].split(',').map(function (h) { return h.trim(); });
        return lines.slice(1).map(function (line) {
            if (!line.trim()) return null;
            var parts = line.split(',');
            var obj = {};
            headers.forEach(function (h, idx) { obj[h] = (parts[idx] || '').trim(); });
            obj.latitude = parseFloat(obj.latitude);
            obj.longitude = parseFloat(obj.longitude);
            if (obj.heading_deg) obj.heading_deg = parseFloat(obj.heading_deg);
            return obj;
        }).filter(function(obj) { return obj && !isNaN(obj.latitude); });
    }

    function groupFrames(rows) {
        var bucket = {};
        rows.forEach(function (r) {
            var ts = r.timestamp_utc;
            if (!ts) return;
            if (!bucket[ts]) { bucket[ts] = []; }
            bucket[ts].push(r);
        });
        return Object.keys(bucket).sort().map(function (ts) {
            return { timestamp: ts, vessels: bucket[ts] };
        });
    }

    function removeContent(id) {
        if (!id) { return; }
        PlatformAPI.publish('3DEXPERIENCity.RemoveContent', id);
    }

    function clearMapObjects() {
        app.activeMarkerIds.forEach(removeContent);
        app.activeMarkerIds = [];
        app.activeTrailIds.forEach(removeContent);
        app.activeTrailIds = [];
    }

    // ===============================================
    // 🖼️ CUSTOM PNG LOGIC
    // ===============================================
    function addMarker(ship) {
        var markerId = CONFIG.MARKER_PREFIX + ship.vessel_id;
        app.activeMarkerIds.push(markerId);
        
        var stage = getVesselStage(ship);

        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: { x: ship.longitude, y: ship.latitude, z: 0 },
            layer: {
                id: markerId,
                name: ship.vessel_name
            },
            render: {
                style: 'picture', // Tells the API to use an external image file
                url: CONFIG.CUSTOM_ICON_URL,
                width: 48,  // You can increase/decrease this to change icon size
                height: 48,
                color: stage.color // Depending on the map engine, this might dynamically tint a white PNG!
            },
            options: {
                projection: { from: 'WGS84' },
                stem: false, // Removes the floating stick
                altitudeMode: 'clampToGround' // Keeps the PNG glued to the water
            }
        });
    }

    function addTrail(ship) {
        if (!app.trails[ship.vessel_id] || app.trails[ship.vessel_id].length < 2) {
            return;
        }
        var trailId = CONFIG.TRAIL_PREFIX + ship.vessel_id;
        app.activeTrailIds.push(trailId);
        
        var stage = getVesselStage(ship);

        PlatformAPI.publish('3DEXPERIENCity.AddLine', {
            json: [{
                type: 'LineString',
                properties: { STRID: ship.vessel_id },
                coordinates: app.trails[ship.vessel_id].map(function (p) { return [p.lon, p.lat]; })
            }],
            layer: {
                id: trailId,
                name: trailId,
                attributeMapping: { STRID: 'id' }
            },
            render: {
                color: stage.color,
                lineWidth: 2
            },
            options: {
                projection: { from: 'WGS84' }
            }
        });
    }

    function renderDetail(ship) {
        app.container.empty();
        
        var wrapper = UWA.createElement('div', {
            styles: { fontFamily: 'Arial,sans-serif' }
        }).inject(app.container);
        
        var stage = getVesselStage(ship);

        UWA.createElement('h2', {
            text: ship.vessel_name || 'Vessel Information',
            styles: { margin: '0 0 5px 0', color: '#0B5CAB' }
        }).inject(wrapper);

        UWA.createElement('div', {
            html: '<span style="background-color:' + stage.color + '; color: white; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; display: inline-block; margin-bottom: 12px;">' + stage.label + '</span>'
        }).inject(wrapper);

        var grid = UWA.createElement('div', {
            styles: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }
        }).inject(wrapper);

        Object.keys(ship).forEach(function (key) {
            if (key !== 'vessel_name' && key !== 'cad_model_id' && ship[key] !== undefined) {
                UWA.createElement('div', {
                    html: '<b>' + formatKey(key) + ':</b> ' + esc(ship[key])
                }).inject(grid);
            }
        });
    }

    function renderDefault() {
        app.container.empty();
        var defaultWrap = UWA.createElement('div', {
            styles: { fontFamily: 'Arial,sans-serif' }
        }).inject(app.container);

        UWA.createElement('div', {
            text: 'Playback active. Click any moving vessel to view its details.',
            styles: { color: '#666', padding: '6px 0 12px 0' }
        }).inject(defaultWrap);

        UWA.createElement('div', {
            html: '<b>Status Legend:</b><br/>' +
                  '<div style="margin-top: 5px; line-height: 1.6;">' +
                  '<span style="color:#2ECC71;">⬤</span> Arriving / Inbound<br/>' +
                  '<span style="color:#E67E22;">⬤</span> Departing / Outbound<br/>' +
                  '<span style="color:#3498DB;">⬤</span> Berthing / Moored<br/>' +
                  '<span style="color:#9B59B6;">⬤</span> In Transit' +
                  '</div>',
            styles: { backgroundColor: '#f9f9f9', padding: '10px', borderRadius: '5px', fontSize: '13px' }
        }).inject(defaultWrap);
    }

    function renderFrame(frame) {
        clearMapObjects();
        frame.vessels.forEach(function (ship) {
            if (!app.trails[ship.vessel_id]) { app.trails[ship.vessel_id] = []; }
            app.trails[ship.vessel_id].push({ lon: ship.longitude, lat: ship.latitude });
            if (app.trails[ship.vessel_id].length > CONFIG.TRAIL_LENGTH) {
                app.trails[ship.vessel_id].shift();
            }
            
            app.byVessel[ship.vessel_id] = ship; 
            
            addMarker(ship);
            addTrail(ship);
        });

        app.statusBar.setText('Playback time: ' + frame.timestamp + ' | Frame ' + (app.frameIndex + 1) + ' of ' + app.frames.length);

        if (app.selectedShipId && app.byVessel[app.selectedShipId]) {
            renderDetail(app.byVessel[app.selectedShipId]);
        }
    }

    function startPlayback() {
        if (app.playbackHandle) { window.clearInterval(app.playbackHandle); }
        app.playbackHandle = window.setInterval(function () {
            app.frameIndex = (app.frameIndex + 1) % app.frames.length;
            renderFrame(app.frames[app.frameIndex]);
        }, CONFIG.PLAYBACK_INTERVAL_MS);
    }

    function subscribeSelection() {
        PlatformAPI.subscribe('3DEXPERIENCity.OnItemSelect', function () {
            Promise.resolve().then(function () {
                return new Promise(function (resolve) {
                    PlatformAPI.publish('3DEXPERIENCity.GetSelectedItems');
                    PlatformAPI.subscribe('3DEXPERIENCity.GetSelectedItemsReturn', function (infos) {
                        PlatformAPI.unsubscribe('3DEXPERIENCity.GetSelectedItemsReturn');
                        resolve(infos);
                    });
                });
            }).then(function (infos) {
                if (!infos) return;
                
                var selected;
                if (infos.data && infos.data.length > 0) {
                    selected = infos.data[infos.data.length - 1];
                } else if (Array.isArray(infos) && infos.length > 0) {
                    selected = infos[infos.length - 1];
                } else {
                    selected = infos;
                }
                if (!selected) return;

                var rawId = String(selected.id || (selected.properties && selected.properties.id) || selected.STRID || '');
                var cleanId = rawId.replace(CONFIG.MARKER_PREFIX, '').replace(CONFIG.TRAIL_PREFIX, '');

                var ship = app.byVessel[cleanId];
                
                if (!ship) {
                    Object.keys(app.byVessel).forEach(function(key) {
                        if (app.byVessel[key].vessel_name === rawId) {
                            ship = app.byVessel[key];
                        }
                    });
                }

                if (ship) {
                    app.selectedShipId = ship.vessel_id;
                    renderDetail(ship);
                }
            });
        });
        
        PlatformAPI.subscribe('3DEXPERIENCity.OnItemDeselect', function () {
            app.selectedShipId = null;
            renderDefault();
        });
    }

    function initUi() {
        widget.body.empty();
        var wrap = UWA.createElement('div', {
            styles: { padding: '12px', fontFamily: 'Arial,sans-serif' }
        }).inject(widget.body);

        UWA.createElement('h1', {
            text: 'Dynamic Vessel Tracking',
            styles: { color: '#0B5CAB', fontSize: '20px', margin: '0 0 8px 0' }
        }).inject(wrap);

        app.statusBar = UWA.createElement('div', {
            text: 'Initializing...',
            styles: { color: '#666', marginBottom: '10px', fontSize: '12px' }
        }).inject(wrap);

        app.container = UWA.createElement('div').inject(wrap);
    }

    function onLoad() {
        initUi();
        subscribeSelection();
        
        apiGetText(CONFIG.CSV_URL)
            .then(parseCsv)
            .then(groupFrames)
            .then(function (frames) {
                app.frames = frames;
                app.frameIndex = 0;
                app.byVessel = {};
                app.trails = {};
                renderDefault();
                
                if (app.frames.length > 0) {
                    renderFrame(app.frames[0]);
                    startPlayback();
                } else {
                    app.statusBar.setText('No valid data found in CSV.');
                }
            })
            .catch(function (err) {
                app.statusBar.setText('Failed to load time-series CSV');
                app.statusBar.setStyle('color', '#C0392B');
                app.container.empty();
                UWA.createElement('pre', {
                    text: safe(err && err.message ? err.message : err),
                    styles: { color: '#C0392B', whiteSpace: 'pre-wrap' }
                }).inject(app.container);
            });
    }

    widget.addEvent('onLoad', onLoad);
    return app;
});
