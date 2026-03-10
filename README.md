
# GNN Web Viewer for Whole Slide Images

Interactive web viewer for exploring **patch embeddings from graph neural networks (GNNs)** on **whole-slide images (WSIs)**.

The tool allows interactive inspection of patch similarity and cluster assignments on large pathology slides.
The interface is designed for **interactive visual analysis**, including use on **tablets**.

---

# Features

## Patch Similarity Map

The left panel shows a **spatial map of all extracted patches**.

Each patch is displayed as a square cell representing the spatial structure of the WSI.

Features:
- patches colored by **cosine similarity**
- cluster ID displayed inside each patch
- selectable patches
- zoomable and pannable map
- colorbar showing similarity scale

Selecting a patch updates the color of all patches according to their cosine similarity with the selected patch.

---

## Whole Slide Image Viewer

The right panel displays the **full WSI** using **OpenSeadragon**.

Features:
- smooth zooming and panning
- selected patch highlighted
- optional **GeoJSON annotation overlay**
- works with very large pathology slides

---

## Annotation Overlay

GeoJSON annotations can be displayed on top of the WSI.

Supported:
- Polygon
- MultiPolygon

Coordinates must be in **original slide coordinate space (level 0)**.

---

# Installation

Create a conda environment:

conda create -n wsi_viewer python=3.10
conda activate wsi_viewer

Install dependencies:

conda install -c conda-forge openslide
pip install openslide-python flask numpy torch torch-geometric psutil

---

# Run the Viewer

Start the Flask server:

python app.py

Open in browser:

http://127.0.0.1:5000

To access from another device (tablet or phone):

http://YOUR_LOCAL_IP:5000

Example:

http://192.168.1.156:5000

---

# Project Structure

GNN_Web_Viewer/
│
├── app.py
├── static/
│   └── main.js
├── templates/
│   └── index.html
├── data/
│   ├── slide.svs
│   ├── graph.pt
│   └── annotation.geojson
├── environment.yml
└── README.md

---

# Large File Handling

Large files such as:

*.svs
*.pt
*.geojson

should **NOT** be committed to Git.

Use `.gitignore` to exclude them.

---

# Use Cases

This viewer is designed for:

- exploring **GNN embeddings on pathology slides**
- inspecting **cluster assignments spatially**
- visualizing **patch similarity relationships**
- interactive exploration of model representations

---

# Future Improvements

Possible extensions:

- patch thumbnails on hover
- selecting patches directly from WSI
- similarity threshold filtering
- embedding search
- multi-slide dataset support
- patch heatmap export

---

# License

MIT License
