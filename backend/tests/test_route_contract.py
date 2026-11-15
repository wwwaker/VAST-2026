"""Current entry points and deliberately retained analysis APIs."""
import unittest

from . import helpers  # Configure the test database before importing the app.
from app.main import app


class RouteContractTest(unittest.TestCase):
    def test_retired_generic_endpoints_are_not_registered(self):
        paths = {route.path for route in app.routes}
        self.assertTrue(paths.isdisjoint({'/api/graph', '/api/graph/evidence', '/api/search'}))

    def test_current_and_retained_capabilities_remain_registered(self):
        paths = {route.path for route in app.routes}
        expected = {
            '/api/mc1-reference/api/heatmap', '/api/mc1-reference/api/line-chart',
            '/api/mc2/relations', '/api/mc2/process', '/api/mc2/file-patterns',
            '/api/runs', '/api/runs/{run_key}', '/api/traces/roots',
            '/api/mc1/context', '/api/compare', '/api/interventions',
            '/api/transitions', '/api/system-overview', '/api/notes',
            '/api/cases', '/api/cases/{case_id}/export', '/api/findings',
        }
        self.assertTrue(expected.issubset(paths), expected - paths)


if __name__ == '__main__':
    unittest.main()
