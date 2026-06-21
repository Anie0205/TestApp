define('VesselPlotting',
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
    'DS/Visualization/ThreeJS_DS',
    'DS/Visualization/SceneGraph',
    'DS/Visualization/MeshGP',
    'DS/Visualization/LineGP',
    'css!DS/UIKIT/UIKIT.css'
],

function (UWA, Promise, String, WAFData, PlatformAPI, Toggler, Autocomplete, Button, Scroller, THREE, SceneGraph, MeshGP, LineGP) {

    'use strict';

    var VesselWidget = {

        // Core viewer instance placeholder
        viewer: null,

        onLoad: function () {
            // 1. Initialize your custom UI or fetch your Map/Globe context
            // In a typical 3DEXPERIENCity environment, we hook into the active Map Viewport
            VesselWidget.viewer = widget.getViewer ? widget.getViewer() : window.virtualEarthViewer;

            if (!VesselWidget.viewer) {
                console.error("3D Viewport/Viewer context not found.");
                return;
            }

            // 2. Plot target ship asset at a given Lat/Lng
            // Example: Centered at specified coordinates
            var targetLat = 12.9716; 
            var targetLng = 77.5946;
            var targetAlt = 0.0; // Sea/Ground Level

            VesselWidget.plotShip(targetLat, targetLng, targetAlt);
        },

        plotShip: function (lat, lng, alt) {
            try {
                // Initialize the container node for the vessel
                var shipNode = SceneGraph.createNode({ name: "Vessel_Asset_Node" });

                // =================================================================
                // 1. DEFINE LOCAL GEOMETRY (Meters relative to ship center 0,0,0)
                // =================================================================
                // Layout: [X (Width), Y (Length/Bow-Stern), Z (Height)]
                var vertices = [
                    0,   25,  0,   // 0: Bow (Waterline tip)
                    6,    8,  0,   // 1: Starboard Front
                    6,  -25,  0,   // 2: Starboard Rear
                   -6,  -25,  0,   // 3: Port Rear
                   -6,    8,  0,   // 4: Port Front
                    0,   25, 10,   // 5: Bow Top (Deck level)
                    6,    8, 10,   // 6: Starboard Deck Front
                    6,  -25, 10,   // 7: Starboard Deck Rear
                   -6,  -25, 10,   // 8: Port Deck Rear
                   -6,    8, 10    // 9: Port Deck Front
                ];

                // --- Polygon Definition (Deck Surface Triangles) ---
                var deckIndices = [
                    5, 6, 9,   // Bow triangle
                    6, 7, 9,   // Mid-deck hull panel A
                    7, 8, 9    // Stern hull panel B
                ];

                var deckMesh = new MeshGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(deckIndices),
                    fill: true,
                    color: 0x333333, // Matte dark gray
                    opacity: 0.95,
                    side: THREE.DoubleSide
                });
                shipNode.addGraphicPrimitive(deckMesh);

                // --- Line/Wireframe Definition (Structural Outline) ---
                var lineIndices = [
                    0, 5,   // Vertical Bow Edge
                    1, 6,   // Vertical Starboard break
                    2, 7,   // Vertical Starboard Transom
                    3, 8,   // Vertical Port Transom
                    4, 9,   // Vertical Port break
                    5, 6, 6, 7, 7, 8, 8, 9, 9, 5, // Deck Gunwale Perimeter Loop
                    0, 1, 1, 2, 2, 3, 3, 4, 4, 0  // Keel/Waterline Perimeter Loop
                ];

                var wireframeLines = new LineGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(lineIndices),
                    color: 0x00FFBB, // Highly visible cyan wireframe
                    lineWidth: 2
                });
                shipNode.addGraphicPrimitive(wireframeLines);

                // =================================================================
                // 2. GEOSPATIAL PROJECTION & TRANSFORM
                // =================================================================
                // Obtain world coordinates from the platform's mapping system
                var geospatialManager = VesselWidget.viewer.getGeospatialManager();
                var worldPos = geospatialManager.fromLatLngToWorld(lat, lng, alt);

                var transformMatrix = new THREE.Matrix4();
                
                // Set orientation angle (e.g., pointing Northeast / 45 degrees)
                var headingAngle = THREE.Math.degToRad(45);
                transformMatrix.makeRotationZ(headingAngle);
                
                // Translate matrix to calculated 3D coordinates
                transformMatrix.setPosition(new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z));

                // Apply transformation to the Node
                shipNode.setMatrix(transformMatrix);

                // Append node to the scene graph root
                var rootNode = VesselWidget.viewer.getRootNode();
                rootNode.addChild(shipNode);

                // Request viewport update
                VesselWidget.viewer.render();

                console.log("Vessel successfully plotted at Lat: " + lat + ", Lng: " + lng);

            } catch (error) {
                console.error("Failed to plot vessel: ", error);
            }
        }
    };

    return VesselWidget;
});