define('VesselPlotting',
[
    'DS/Visualization/ThreeJS_DS',
    'DS/Visualization/SceneGraph',
    'DS/Visualization/MeshGP',
    'DS/Visualization/LineGP'
],

function (THREE, SceneGraph, MeshGP, LineGP) {

    'use strict';

    var VesselWidget = {
        viewer: null,

        onLoad: function () {
            VesselWidget.viewer = widget.getViewer ? widget.getViewer() : window.virtualEarthViewer;

            if (!VesselWidget.viewer) return;

            // Target coordinates (e.g., specific port location)
            VesselWidget.plotShip(18.94543, 72.92450, 0.0);
        },

        plotShip: function (lat, lng, alt) {
            try {
                var shipNode = SceneGraph.createNode({ name: "Vessel_Asset_Node" });

                // Coordinate set: [X, Y, Z]
                var vertices = [
                    0,   25,  0,   6,    8,  0,   6,  -25,  0,  -6,  -25,  0,  -6,    8,  0,
                    0,   25, 10,   6,    8, 10,   6,  -25, 10,  -6,  -25, 10,  -6,    8, 10
                ];

                var deckIndices = [5, 6, 9, 6, 7, 9, 7, 8, 9];
                var lineIndices = [0,5, 1,6, 2,7, 3,8, 4,9, 5,6, 6,7, 7,8, 8,9, 9,5, 0,1, 1,2, 2,3, 3,4, 4,0];

                shipNode.addGraphicPrimitive(new MeshGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(deckIndices),
                    fill: true, color: 0x333333, opacity: 0.95, side: THREE.DoubleSide
                }));

                shipNode.addGraphicPrimitive(new LineGP({
                    vertices: new Float32Array(vertices),
                    indices: new Uint32Array(lineIndices),
                    color: 0x00FFBB, lineWidth: 2
                }));

                var worldPos = VesselWidget.viewer.getGeospatialManager().fromLatLngToWorld(lat, lng, alt);
                var transformMatrix = new THREE.Matrix4();
                transformMatrix.makeRotationZ(THREE.Math.degToRad(45));
                transformMatrix.setPosition(new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z));

                shipNode.setMatrix(transformMatrix);
                VesselWidget.viewer.getRootNode().addChild(shipNode);
                VesselWidget.viewer.render();

            } catch (error) {
                console.error("Plotting runtime failure: ", error);
            }
        }
    };

    return VesselWidget;
});