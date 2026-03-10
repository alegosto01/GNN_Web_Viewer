from flask import Flask, render_template, jsonify, abort, Response
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator
import torch
import torch.nn.functional as F
import numpy as np
import io
import json
app = Flask(__name__)

SLIDE_PATH = "/home/ale/Desktop/GNN_Web_Viewer/data/TCGA-43-6143-01Z-00-DX1.52d974a8-3f07-4e7f-8d3f-5d47f321298c.svs"
GRAPH_PATH = "/home/ale/Desktop/GNN_Web_Viewer/data/tcga-43-6143-01z-00-dx1.pt"
GEOJSON_PATH = "/home/ale/Desktop/GNN_Web_Viewer/data/TCGA-43-6143-01Z-00-DX1.52d974a8-3f07-4e7f-8d3f-5d47f321298c.geojson"



PATCH_SIZE = 224           # patch size in slide pixels, adjust if needed
COORD_SCALE = 1.0          # change this later if data.pos is not in svs space

# -------------------------
# Load slide
# -------------------------
slide = OpenSlide(SLIDE_PATH)
dz = DeepZoomGenerator(slide, tile_size=PATCH_SIZE, overlap=0, limit_bounds=False)

slide_width, slide_height = slide.dimensions

# -------------------------
# Load graph
# -------------------------
data = torch.load(GRAPH_PATH, map_location="cpu", weights_only=False)

coords = data.pos.detach().cpu().numpy().astype(np.float32)
features = data.zn.detach().float().cpu()
clusters = data.x.detach().cpu().numpy()

if clusters.ndim == 2 and clusters.shape[1] == 1:
    clusters = clusters[:, 0]

features = F.normalize(features, dim=1)

num_patches = coords.shape[0]

# -------------------------
# Helpers
# -------------------------
def cluster_value(i):
    v = clusters[i]
    if np.issubdtype(type(v), np.integer) or np.issubdtype(np.array(v).dtype, np.integer):
        return int(v)
    return float(v)

def get_patch_record(i, score=None):
    x = float(coords[i, 0] * COORD_SCALE)
    y = float(coords[i, 1] * COORD_SCALE)

    record = {
        "patch_id": int(i),
        "x": x,
        "y": y,
        "width": PATCH_SIZE,
        "height": PATCH_SIZE,
        "cluster": cluster_value(i),
    }
    if score is not None:
        record["score"] = float(score)
    return record

# -------------------------
# Routes
# -------------------------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/dzi")
def dzi():
    return Response(dz.get_dzi("jpeg"), mimetype="application/xml")

@app.route("/dzi_files/<int:level>/<int:col>_<int:row>.jpeg")
def tile(level, col, row):
    try:
        tile = dz.get_tile(level, (col, row))
    except Exception:
        abort(404)

    buf = io.BytesIO()
    tile.save(buf, format="JPEG")
    buf.seek(0)
    return Response(buf.getvalue(), mimetype="image/jpeg")

@app.route("/annotation")
def annotation():
    with open(GEOJSON_PATH, "r") as f:
        data = json.load(f)
    return jsonify(data)

@app.route("/slide_info")
def slide_info():
    return jsonify({
        "width": slide_width,
        "height": slide_height,
        "num_patches": int(num_patches),
        "embedding_dim": int(features.shape[1]),
        "coord_min": coords.min(axis=0).tolist(),
        "coord_max": coords.max(axis=0).tolist(),
        "patch_size": PATCH_SIZE,
        "coord_scale": COORD_SCALE,
    })

@app.route("/patches")
def patches():
    return jsonify([get_patch_record(i) for i in range(num_patches)])

@app.route("/similarities/<int:patch_id>")
def similarities(patch_id):
    if patch_id < 0 or patch_id >= num_patches:
        abort(404)

    query = features[patch_id]
    sims = torch.matmul(features, query).cpu().numpy()

    result = [get_patch_record(i, score=sims[i]) for i in range(num_patches)]
    result.sort(key=lambda d: d["score"], reverse=True)
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)