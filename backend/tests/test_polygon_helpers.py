"""Unit tests for the pure geometry helpers in processing/polygon.py.

streets_to_geojson / extract_city_block need live PostGIS + OSM data and are
deliberately not unit-tested here.
"""

import math

import pytest
from shapely.geometry import LineString, MultiLineString, Point

from processing import polygon


# ---------------------------------------------------------------------------
# extend_line
# ---------------------------------------------------------------------------

def test_extend_line_extends_both_ends_of_horizontal_line():
    line = LineString([(0, 0), (100, 0)])
    extended = polygon.extend_line(line, distance=50)

    coords = list(extended.coords)
    assert coords[0] == (-50.0, 0.0)
    assert coords[-1] == (150.0, 0.0)
    # Original points are preserved in the middle
    assert (0.0, 0.0) in coords and (100.0, 0.0) in coords


def test_extend_line_diagonal_preserves_direction():
    line = LineString([(0, 0), (3, 4)])  # length 5, direction (0.6, 0.8)
    extended = polygon.extend_line(line, distance=5)

    coords = list(extended.coords)
    assert coords[0] == pytest.approx((-3.0, -4.0))
    assert coords[-1] == pytest.approx((6.0, 8.0))


def test_extend_line_length_grows_by_twice_the_distance():
    line = LineString([(0, 0), (10, 0), (10, 10)])
    extended = polygon.extend_line(line, distance=7)
    assert extended.length == pytest.approx(line.length + 14)


def test_extend_line_none_and_empty_are_passed_through():
    assert polygon.extend_line(None) is None
    empty = LineString()
    assert polygon.extend_line(empty) is empty


def test_extend_line_zero_length_first_segment_does_not_divide_by_zero():
    # First two coords identical -> len0 == 0 -> start must stay unchanged
    line = LineString([(5, 5), (5, 5), (10, 5)])
    extended = polygon.extend_line(line, distance=10)
    assert list(extended.coords)[0] == (5.0, 5.0)


# ---------------------------------------------------------------------------
# extend_geometry
# ---------------------------------------------------------------------------

def test_extend_geometry_linestring_delegates_to_extend_line():
    line = LineString([(0, 0), (100, 0)])
    extended = polygon.extend_geometry(line, distance=25)
    assert list(extended.coords)[0] == (-25.0, 0.0)


def test_extend_geometry_multilinestring_extends_every_part():
    mls = MultiLineString([
        [(0, 0), (100, 0)],
        [(0, 50), (100, 50)],
    ])
    extended = polygon.extend_geometry(mls, distance=10)

    # Both parts got 20 units longer (10 on each end)
    assert extended.length == pytest.approx(mls.length + 40)


def test_extend_geometry_unsupported_type_returned_unchanged():
    point = Point(1, 2)
    assert polygon.extend_geometry(point) is point


def test_extend_geometry_none_and_empty_passed_through():
    assert polygon.extend_geometry(None) is None
    empty = LineString()
    assert polygon.extend_geometry(empty) is empty


# ---------------------------------------------------------------------------
# is_point_in_block
# ---------------------------------------------------------------------------

def test_is_point_in_block_none_polygon_returns_false():
    assert polygon.is_point_in_block(43.2, 27.9, None, None, None) is False
