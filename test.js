/*global window, widget, define*/

define('xCityLiveSTARApp',
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
// ================================
// 🔹 CSV DATA (EMBEDDED)
// ================================
var CSV_DATA = `vessel_name	imo	mmsi	call_sign	vessel_type	navigation_status	latitude	longitude	speed_knots	heading_deg	course_over_ground_deg	destination	eta_utc	berth_assignment	draught_m	loa_m	beam_m	operator	last_update_utc	alert_state	route_segment	remarks
MV SAGAR PRIDE	9400011	419000103	VTAH39	Container Vessel	Anchored	18.960337	72.902751	1.1	52	50	Dubai	2026-04-23T08:11:06Z	BMCT-01	13.2	259	48	Adani Ports	2026-04-23T07:24:02Z	Warning	Anchorage	On schedule
MSC AURORA	9400164	419000122	VTBI23	Bulk Carrier	Awaiting Pilot	18.973469	72.917563	10.8	216	220	JNPA	2026-04-23T10:20:06Z	JNPCT-04	10.2	208	38	MSC	2026-04-23T07:23:59Z	Warning	Approach Channel	Pilot onboard
MV OCEAN SPIRIT	9400303	419000138	VTCJ20	Ro-Ro Vessel	Outbound Channel	18.898668	72.93225	2.2	185	180	Mundra	2026-04-23T08:27:06Z	BMCT-02	9.4	282	45	CMA CGM	2026-04-23T07:24:22Z	Normal	Turning Basin	Ready for berthing
MT BLUE HORIZON	9400442	419000153	VTDK69	LNG Carrier	Anchored	18.919368	73.003032	1.1	331	331	Dubai	2026-04-23T16:47:06Z	NSFT-01	13.6	176	42	MSC	2026-04-23T07:24:58Z	Normal	Anchorage	Pilot onboard
MV GATEWAY STAR	9400606	419000170	VTEL43	Tanker	Outbound Channel	18.919451	72.923208	15.7	161	160	Dubai	2026-04-23T14:26:06Z	Anchorage-A	12.3	187	49	Hapag-Lloyd	2026-04-23T07:24:24Z	Normal	Turning Basin	Under monitoring
MV ARABIAN LINK	9400739	419000186	VTFM59	LNG Carrier	Inbound Channel	18.944287	72.983136	5.1	56	62	Cochin	2026-04-23T19:17:06Z	NSFT-01	9.1	261	22	Maersk	2026-04-23T07:23:39Z	Normal	Pilot Boarding Zone	Awaiting clearance
MV PACIFIC CREST	9400902	419000206	VTGN91	Ro-Ro Vessel	Inbound Channel	18.902271	72.947824	0	134	130	Hazira	2026-04-23T09:29:06Z	Anchorage-B	14.4	258	55	MSC	2026-04-23T07:23:23Z	Normal	Inner Harbor	On schedule
MT SEA EMPRESS	9401031	419000220	VTHO20	Coastal Cargo	Outbound Channel	18.902305	72.939928	10.8	157	151	Singapore	2026-04-23T11:47:06Z	BMCT-01	12	152	30	MOL	2026-04-23T07:23:36Z	Normal	Anchorage	Under monitoring
MV WESTERN BAY	9401143	419000243	VTIP76	Coastal Cargo	Outbound Channel	18.985968	72.946545	9.2	353	348	Mumbai Anchorage	2026-04-23T14:29:06Z	JNPCT-04	8.8	206	23	Adani Ports	2026-04-23T07:23:26Z	Normal	Approach Channel	On schedule
MV NAVA SHEVA ONE	9401298	419000256	VTJQ45	Coastal Cargo	Approaching Berth	18.967863	72.906476	12.8	34	32	Cochin	2026-04-23T08:53:06Z	BPCL-Jetty	7.9	359	58	MOL	2026-04-23T07:24:54Z	Watch	Inner Harbor	Minor delay
MV MERCHANT WIND	9401401	419000273	VTKR34	Coastal Cargo	Anchored	18.900376	72.972488	0.1	27	23	Mundra	2026-04-23T09:32:06Z	BPCL-Jetty	8.4	238	37	Maersk	2026-04-23T07:24:03Z	Warning	Approach Channel	On schedule
MV EASTERN TIDE	9401559	419000294	VTLS71	Ro-Ro Vessel	Anchored	18.961736	72.959465	1.7	7	11	JNPA	2026-04-23T10:31:06Z	NSIGT-03	8.2	120	46	SCI	2026-04-23T07:24:00Z	Normal	Inner Harbor	Ready for berthing
MV CORAL STREAM	9401651	419000312	VTMT17	General Cargo	Outbound Channel	18.995305	73.009496	2	79	72	JNPA	2026-04-23T11:23:06Z	JNPCT-04	12.5	248	55	CMA CGM	2026-04-23T07:25:42Z	Warning	Approach Channel	Minor delay
MV HARBOR GLORY	9401812	419000321	VTNU89	Bulk Carrier	Under Tow	18.897537	72.907476	5.8	120	125	Dubai	2026-04-23T17:24:06Z	BMCT-02	12.5	253	42	SCI	2026-04-23T07:25:04Z	Normal	Turning Basin	Awaiting clearance
MV INDUS VOYAGER	9401990	419000339	VTOV19	Ro-Ro Vessel	Approaching Berth	18.933536	72.973886	6.9	37	45	Hazira	2026-04-23T18:17:06Z	Anchorage-A	7.9	209	26	Adani Ports	2026-04-23T07:24:22Z	Normal	Turning Basin	Pilot onboard
MV RIVER CROWN	9402068	419000357	VTPW43	Bulk Carrier	Approaching Berth	18.981712	72.977389	11.3	313	308	Dubai	2026-04-23T12:47:06Z	Anchorage-B	12.2	189	40	Adani Ports	2026-04-23T07:24:29Z	Normal	Pilot Boarding Zone	Ready for berthing
MT SILVER CURRENT	9402192	419000377	VTQX26	Feeder Container	Anchored	18.98382	72.955595	1.1	26	23	Dubai	2026-04-23T08:26:06Z	JNPCT-04	11.1	300	49	MSC	2026-04-23T07:25:28Z	Normal	Pilot Boarding Zone	Minor delay
MV JADE TRIDENT	9402334	419000393	VTRY56	Container Vessel	Inbound Channel	18.950015	72.991805	16.7	298	301	Mumbai Anchorage	2026-04-23T09:51:06Z	GTI-02	13.5	290	28	ONE	2026-04-23T07:23:33Z	Watch	Berth Pocket	Ready for berthing
MV MARINA QUEST	9402508	419000412	VTSZ95	Ro-Ro Vessel	Under Tow	18.907001	73.002287	15.2	90	90	Mumbai Anchorage	2026-04-23T10:44:06Z	BMCT-01	14.6	147	46	MSC	2026-04-23T07:23:56Z	Normal	Turning Basin	Pilot onboard
MV GLOBAL PEARL	9402627	419000429	VTTA52	Feeder Container	Outbound Channel	18.928462	72.990259	0	116	110	Singapore	2026-04-23T18:56:06Z	BMCT-01	9.4	284	54	Hapag-Lloyd	2026-04-23T07:23:39Z	Normal	Approach Channel	On schedule
MV SUNLIT WAVE	9402795	419000448	VTUB24	LNG Carrier	Anchored	18.986474	72.928734	1.1	19	17	Hazira	2026-04-23T13:02:06Z	BPCL-Jetty	7	231	22	Adani Ports	2026-04-23T07:24:23Z	Watch	Approach Channel	Ready for berthing
MV TITAN EXPRESS	9402916	419000463	VTVC51	LNG Carrier	Anchored	18.991285	72.968547	1.3	339	340	Cochin	2026-04-23T16:20:06Z	JNPCT-04	7.8	227	46	CMA CGM	2026-04-23T07:23:19Z	Warning	Anchorage	Pilot onboard
MV NEPTUNE TRAIL	9403070	419000477	VTWD75	Coastal Cargo	Awaiting Pilot	18.950273	72.900045	7	296	293	Dubai	2026-04-23T15:13:06Z	Anchorage-A	7.4	251	43	Maersk	2026-04-23T07:24:56Z	Normal	Turning Basin	Minor delay
MT OCEAN CREST	9403200	419000498	VTXE61	Ro-Ro Vessel	Anchored	18.906209	72.905084	0.8	243	239	Dubai	2026-04-23T11:00:06Z	Pilot-Station	13.6	348	28	Hapag-Lloyd	2026-04-23T07:25:00Z	Normal	Pilot Boarding Zone	Under monitoring
MV PORT VISION	9403328	419000515	VTYF88	LNG Carrier	Holding Position	18.9411	72.961315	1.2	68	74	Mumbai Anchorage	2026-04-23T17:50:06Z	Anchorage-B	14.2	241	50	SCI	2026-04-23T07:24:53Z	Normal	Berth Pocket	Pilot onboard
MV DELTA VOYAGE	9403494	419000526	VTZG27	Tanker	Berthed	18.958942	72.930206	0.4	39	38	Mundra	2026-04-23T13:08:06Z	BPCL-Jetty	13.6	300	35	Maersk	2026-04-23T07:24:10Z	Watch	Anchorage	Under monitoring
MV COASTAL RUNNER	9403623	419000542	VTAH55	Feeder Container	Approaching Berth	18.941252	72.906849	10	299	303	Singapore	2026-04-23T14:10:06Z	Pilot-Station	15.7	333	48	Adani Ports	2026-04-23T07:23:52Z	Normal	Anchorage	Pilot onboard
MV UNITY BRIDGE	9403715	419000567	VTBI13	LNG Carrier	Under Tow	18.943421	72.942774	4.6	342	334	JNPA	2026-04-23T15:39:06Z	NSFT-01	13.1	154	51	CMA CGM	2026-04-23T07:25:44Z	Normal	Inner Harbor	Awaiting clearance
MV HORIZON ACE	9403905	419000576	VTCJ54	Ro-Ro Vessel	Berthed	18.913283	72.935953	1.5	215	209	Singapore	2026-04-23T08:00:06Z	Anchorage-A	16.4	130	23	Adani Ports	2026-04-23T07:25:05Z	Normal	Berth Pocket	Minor delay
MV BLUE MERIDIAN	9404020	419000595	VTDK87	Bulk Carrier	Outbound Channel	18.91624	72.952092	4.1	58	55	Hazira	2026-04-23T12:03:06Z	Anchorage-A	7.6	126	41	Hapag-Lloyd	2026-04-23T07:24:15Z	Normal	Approach Channel	Under monitoring`;

// ================================
// 🔹 PARSE CSV
// ================================
function parseCSV(csvText) {

    var lines = csvText.trim().split('\n');
    var headers = lines[0].split('\t');

    return lines.slice(1).map(function (line) {

        var values = line.split('\t');
        var obj = {};

        headers.forEach(function (h, i) {
            obj[h.trim()] = values[i] ? values[i].trim() : '';
        });

        obj.latitude = parseFloat(obj.latitude);
        obj.longitude = parseFloat(obj.longitude);

        return obj;
    });
}

var ALL_SHIPS = parseCSV(CSV_DATA);

// ================================
// 🔹 HELPER: Sentence Case
// ================================
function formatKey(key) {
    key = key.replace(/_/g, ' ');
    return key.charAt(0).toUpperCase() + key.slice(1);
}

// ================================
// 🔹 GET SELECTION
// ================================
function getSelectionInfos() {

    return new Promise(function (resolve) {

        PlatformAPI.publish('3DEXPERIENCity.GetSelectedItems');

        PlatformAPI.subscribe('3DEXPERIENCity.GetSelectedItemsReturn', function (infos) {
            PlatformAPI.unsubscribe('3DEXPERIENCity.GetSelectedItemsReturn');
            resolve(infos);
        });
    });
}

// ================================
// 🔹 BUILD UI (Sentence Case)
// ================================
function buildShipContent(ship) {

    var container = UWA.createElement('div');

    UWA.createElement('h4', {
        text: 'Ship Information'
    }).inject(container);

    Object.keys(ship).forEach(function (key) {

        UWA.createElement('div', {
            html: '<b>' + formatKey(key) + ':</b> ' + ship[key]
        }).inject(container);

    });

    return container;
}

// ================================
// 🔹 CREATE MARKERS (Sentence + |)
// ================================
function createShipMarker(ship) {

    var descriptionParts = [];

    Object.keys(ship).forEach(function (key) {

        descriptionParts.push(
            formatKey(key) + ': ' + ship[key]
        );

    });

    var descriptionText = descriptionParts.join(' | ');

    var markerInfos = {
        widgetID: widget.id,
        position: {
            x: ship.longitude,
            y: ship.latitude
        },
        layer: {
            id: ship.vessel_name,
            name: ship.vessel_name,
            description: descriptionText
        },
        render: {
            style: 'annotation',
            color: '#ECECEC'
        },
        options: {
            projection: { from: 'WGS84' }
        }
    };

    PlatformAPI.publish('3DEXPERIENCity.AddMarker', markerInfos);
}

// ================================
// 🔹 MAIN APP
// ================================
var app = {

    onLoad: function () {

        widget.setBody('');

        app.container = UWA.createElement('div', {
            styles: { padding: '10px' }
        }).inject(widget.body);

        function defaultMessage() {
            app.container.empty();
            UWA.createElement('div', {
                text: 'Please Click the Vessel to view its details....',
                styles: { color: '#666' }
            }).inject(app.container);
        }

        defaultMessage();

        ALL_SHIPS.forEach(createShipMarker);

        PlatformAPI.subscribe('3DEXPERIENCity.OnItemSelect', function () {

            return getSelectionInfos().then(function (infos) {

                if (!infos || !infos.data || infos.data.length === 0) return;

                var selected = infos.data[infos.data.length - 1];

                var ship = ALL_SHIPS.find(function (s) {
                    return s.vessel_name === selected.id;
                });

                if (!ship) return;

                app.container.empty(true);
                buildShipContent(ship).inject(app.container);
            });
        });

        PlatformAPI.subscribe('3DEXPERIENCity.OnItemDeselect', function () {
            defaultMessage();
        });
    }
};

widget.addEvent('onLoad', app.onLoad);

return app;

});
