from flask import Flask, render_template, jsonify, abort, Response
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator
import pandas as pd
import io

app = Flask(__name__)

SLIDE_PATH = "data/slide.svs"
PATCHES_PATH = "data/patches.csv"

slide = OpenSlide(SLIDE_PATH)
dz = DeepZoomGenerator(slide, tile_size=256, overlap=0, limit_bounds=False)

patches_df = pd.read_csv(PATCHES_PATH)

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/dzi")
def dzi():
    return Response(dz.get_dzi("jpeg"), mimetype="application/xml")

@app.route("/tiles/<int:level>/<int:col>_<int:row>.jpeg")
def tile(level, col, row):
    try:
        tile = dz.get_tile(level, (col, row))
    except Exception:
        abort(404)

    buf = io.BytesIO()
    tile.save(buf, format="JPEG")
    buf.seek(0)
    return Response(buf.getvalue(), mimetype="image/jpeg")

@app.route("/patches")
def patches():
    return jsonify(patches_df.to_dict(orient="records"))

@app.route("/slide_info")
def slide_info():
    return jsonify({
        "width": slide.dimensions[0],
        "height": slide.dimensions[1],
        "levels": slide.level_dimensions,
        "mpp_x": slide.properties.get("openslide.mpp-x"),
        "mpp_y": slide.properties.get("openslide.mpp-y"),
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
