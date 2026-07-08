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

    var JSON_URL = 'https://test-app-lyart-six.vercel.app/static/xCityJNPAUseCase1App/comprehensive_macro_view.json';

    var DATA = [];
    
    // Updated state to track Year and Terminal instead of Vessel specifics
    var state = {
        year: 'ALL',
        terminal: 'ALL'
    };

    // --- Helper function for dropdowns ---
    function uniq(arr) {
        return arr.filter(function(value, index, self) {
            return self.indexOf(value) === index;
        }).sort();
    }

    // --- Data Fetching ---
    function loadModelData() {
        return new Promise(function (resolve, reject) {
            WAFData.proxifiedRequest(JSON_URL, {
                method: 'GET',
                type: 'json',
                onComplete: function (response) {
                    DATA = response; 
                    resolve();
                },
                onFailure: function (error) {
                    reject(error);
                }
            });
        });
    }

    // --- Build the UI Controls ---
    function buildUI() {
        var container = widget.body;
        container.empty();

        // Create a simple top bar for controls
        var controls = UWA.createElement('div', {
            styles: { padding: '10px', background: '#f4f5f6', borderBottom: '1px solid #d1d4d4', marginBottom: '10px' }
        });

        // 1. YEAR Dropdown
        controls.addContent(UWA.createElement('span', { html: '<b>Year: </b>', styles: { marginRight: '5px' } }));
        var yearSelect = UWA.createElement('select', { styles: { marginRight: '20px', padding: '5px' } });
        
        var years = ['ALL'].concat(uniq(DATA.map(function(r) { return r.year; })));
        yearSelect.setHTML(years.map(function(v) { return '<option value="' + v + '">' + v + '</option>'; }).join(''));
        yearSelect.addEvent('change', function(e) { 
            state.year = e.target.value; 
            render(); 
        });
        controls.addContent(yearSelect);

        // 2. TERMINAL Dropdown
        controls.addContent(UWA.createElement('span', { html: '<b>Terminal: </b>', styles: { marginRight: '5px' } }));
        var terminalSelect = UWA.createElement('select', { styles: { marginRight: '20px', padding: '5px' } });
        
        var terminals = ['ALL'].concat(uniq(DATA.map(function(r) { return r.terminal; })));
        terminalSelect.setHTML(terminals.map(function(v) { return '<option value="' + v + '">' + v + '</option>'; }).join(''));
        terminalSelect.addEvent('change', function(e) { 
            state.terminal = e.target.value; 
            render(); 
        });
        controls.addContent(terminalSelect);

        container.addContent(controls);

        // Create the dashboard container
        var dashboardDiv = UWA.createElement('div', { id: 'macro-dashboard', styles: { padding: '10px' } });
        container.addContent(dashboardDiv);
    }

    // --- Render the Data (The "Macro" Dashboard) ---
    function render() {
        var dashboardDiv = widget.body.getElement('#macro-dashboard');
        dashboardDiv.empty();

        // Filter the data based on dropdown selections
        var filteredData = DATA.filter(function(r) {
            var matchYear = (state.year === 'ALL' || String(r.year) === state.year);
            var matchTerminal = (state.terminal === 'ALL' || r.terminal === state.terminal);
            return matchYear && matchTerminal;
        });

        if (filteredData.length === 0) {
            dashboardDiv.setHTML('<h3>No data available for these filters.</h3>');
            return;
        }

        // Calculate overarching KPIs for the filtered data
        var totalVessels = 0;
        var totalVolume = 0;
        var sumBerthHours = 0;
        var sumCraneProd = 0;

        filteredData.forEach(function(row) {
            totalVessels += row.total_vessels_handled;
            totalVolume += row.total_container_volume;
            sumBerthHours += row.avg_berth_hours;
            sumCraneProd += row.avg_crane_productivity;
        });

        var avgBerth = (sumBerthHours / filteredData.length).toFixed(2);
        var avgCrane = (sumCraneProd / filteredData.length).toFixed(2);

        // Build the KPI HTML using the new Macro Metrics
        var html = '<h2>5-Year Port Productivity Overview</h2>';
        html += '<div style="display: flex; gap: 20px; flex-wrap: wrap; margin-top: 20px;">';
        
        // KPI 1: Vessels
        html += '<div style="flex: 1; min-width: 150px; padding: 15px; background: #fff; border: 1px solid #e2e4e4; border-left: 4px solid #005686; border-radius: 4px;">';
        html += '<div style="font-size: 12px; color: #777; text-transform: uppercase;">Total Vessels Handled</div>';
        html += '<div style="font-size: 24px; font-weight: bold; color: #333;">' + totalVessels.toLocaleString() + '</div>';
        html += '</div>';

        // KPI 2: Volume
        html += '<div style="flex: 1; min-width: 150px; padding: 15px; background: #fff; border: 1px solid #e2e4e4; border-left: 4px solid #005686; border-radius: 4px;">';
        html += '<div style="font-size: 12px; color: #777; text-transform: uppercase;">Total Container Volume (TEUs)</div>';
        html += '<div style="font-size: 24px; font-weight: bold; color: #333;">' + totalVolume.toLocaleString() + '</div>';
        html += '</div>';

        // KPI 3: Crane Productivity
        html += '<div style="flex: 1; min-width: 150px; padding: 15px; background: #fff; border: 1px solid #e2e4e4; border-left: 4px solid #ea4f37; border-radius: 4px;">';
        html += '<div style="font-size: 12px; color: #777; text-transform: uppercase;">Avg Crane Productivity</div>';
        html += '<div style="font-size: 24px; font-weight: bold; color: #333;">' + avgCrane + ' <span style="font-size: 14px; font-weight: normal;">moves/hr</span></div>';
        html += '</div>';

        // KPI 4: Berth Time
        html += '<div style="flex: 1; min-width: 150px; padding: 15px; background: #fff; border: 1px solid #e2e4e4; border-left: 4px solid #ea4f37; border-radius: 4px;">';
        html += '<div style="font-size: 12px; color: #777; text-transform: uppercase;">Avg Berth Hours</div>';
        html += '<div style="font-size: 24px; font-weight: bold; color: #333;">' + avgBerth + ' <span style="font-size: 14px; font-weight: normal;">hrs</span></div>';
        html += '</div>';
        
        html += '</div>'; // Close Flexbox

        // A quick data table to show the underlying rows
        html += '<h3 style="margin-top: 30px;">Breakdown</h3>';
        html += '<table style="width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px;">';
        html += '<tr style="background: #f4f5f6; border-bottom: 2px solid #d1d4d4;"><th style="text-align: left; padding: 8px;">Year</th><th style="text-align: left; padding: 8px;">Terminal</th><th style="text-align: right; padding: 8px;">Vessels</th><th style="text-align: right; padding: 8px;">Volume</th><th style="text-align: right; padding: 8px;">Crane Moves/Hr</th></tr>';
        
        filteredData.forEach(function(row) {
            html += '<tr style="border-bottom: 1px solid #eee;">';
            html += '<td style="padding: 8px;">' + row.year + '</td>';
            html += '<td style="padding: 8px;">' + row.terminal + '</td>';
            html += '<td style="padding: 8px; text-align: right;">' + row.total_vessels_handled + '</td>';
            html += '<td style="padding: 8px; text-align: right;">' + row.total_container_volume + '</td>';
            html += '<td style="padding: 8px; text-align: right;">' + row.avg_crane_productivity.toFixed(2) + '</td>';
            html += '</tr>';
        });
        html += '</table>';

        dashboardDiv.setHTML(html);
    }

    // --- Widget Initialization ---
    function onLoad() {
        loadModelData().then(function() {
            console.log("Successfully loaded " + DATA.length + " Macro records.");
            buildUI();
            render();
        }).catch(function(err) {
            console.error("Failed to load Macro JSON.", err);
        });
    }

    widget.addEvent('onLoad', onLoad);

    // End of widget logic
    return {};
});