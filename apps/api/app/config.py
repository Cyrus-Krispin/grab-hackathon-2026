from __future__ import annotations

import os
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/api/app/config.py -> monorepo root = two levels up
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(os.path.join(_ROOT, ".env"), os.path.join(_ROOT, ".env.local")),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Default matches GrabMaps gateway (see repo SKILL.md §3)
    grab_base_url: str = Field(
        default="https://maps.grab.com",
        validation_alias="GRABMAPS_BASE_URL",
    )
    grab_api_key: str = Field(default="", validation_alias="GRABMAPS_API_KEY")
    use_directions_fixture: int = Field(default=0, validation_alias="USE_DIRECTIONS_FIXTURE")

    # Fixed Singapore O/D (lat, lng)
    demo_origin_lat: float = 1.3048
    demo_origin_lng: float = 103.8324
    demo_dest_lat: float = 1.3505
    demo_dest_lng: float = 103.8488


@lru_cache
def get_settings() -> Settings:
    return Settings()
